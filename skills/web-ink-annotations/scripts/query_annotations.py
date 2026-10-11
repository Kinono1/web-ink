#!/usr/bin/env python3
"""Read one selected Web Ink JSON export without changing it or using a service."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import stat
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


MAX_BYTES = 20 * 1024 * 1024
MAX_ANNOTATIONS = 50_000
MAX_NATIVE_REPLIES = 500
MAX_NATIVE_CONTENTS = 1_000_000
MAX_NATIVE_AUTHOR = 4_096
MAX_REVISION = 1_000_000_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
KINDS = {"text", "image", "pdf-text", "pdf-area"}
CONTROL = re.compile(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]")
UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
HASH = re.compile(r"^[0-9a-fA-F]{64}$")
DATA_IMAGE = re.compile(r"^data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$", re.IGNORECASE)


class QueryError(ValueError):
    """An invalid command or export that must not be queried."""


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise QueryError(message)


def output(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def has_lone_surrogate(value: str) -> bool:
    return any(0xD800 <= ord(character) <= 0xDFFF for character in value)


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise QueryError(f"{name} must be an object")
    return value


def exact_keys(value: dict[str, Any], name: str, required: set[str], optional: set[str] | None = None) -> None:
    if any(has_lone_surrogate(key) for key in value):
        raise QueryError(f"{name} has an invalid field name")
    allowed = required | (optional or set())
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise QueryError(f"{name} has an unknown field: {unknown[0]}")
    missing = sorted(required - set(value))
    if missing:
        raise QueryError(f"{name}.{missing[0]} is required")


def require_text(value: Any, name: str, maximum: int, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or has_lone_surrogate(value):
        raise QueryError(f"{name} must be plain text up to {maximum} characters")
    if utf16_length(value) > maximum or (not allow_empty and not value) or CONTROL.search(value):
        raise QueryError(f"{name} must be plain text up to {maximum} characters")
    return value


def require_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum or abs(value) > MAX_SAFE_INTEGER:
        raise QueryError(f"{name} is out of range")
    return value


def require_number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QueryError(f"{name} is out of range")
    try:
        number = float(value)
    except OverflowError as error:
        raise QueryError(f"{name} is out of range") from error
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise QueryError(f"{name} is out of range")
    return number


def parse_timestamp(value: Any, name: str) -> datetime:
    timestamp = require_text(value, name, 64, allow_empty=False)
    if not UTC_TIMESTAMP.fullmatch(timestamp):
        raise QueryError(f"{name} must be an ISO-8601 UTC timestamp")
    try:
        body = timestamp[:-1]
        pattern = "%Y-%m-%dT%H:%M:%S.%f" if "." in body else "%Y-%m-%dT%H:%M:%S"
        return datetime.strptime(body + "+0000", pattern + "%z")
    except ValueError as error:
        raise QueryError(f"{name} must be an ISO-8601 UTC timestamp") from error


def parse_url(value: str, name: str):
    try:
        return urlparse(value)
    except ValueError as error:
        raise QueryError(f"{name} must be an HTTP(S) URL") from error


def require_http_url(value: Any, name: str, maximum: int = 8_192) -> str:
    url = require_text(value, name, maximum, allow_empty=False)
    parsed = parse_url(url, name)
    try:
        host = parsed.hostname
        parsed.port
    except ValueError as error:
        raise QueryError(f"{name} must be an HTTP(S) URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not host or any(char.isspace() for char in url):
        raise QueryError(f"{name} must be an HTTP(S) URL")
    return url


def require_canonical_page_url(value: Any, name: str) -> str:
    """Mirror pageKey's hash rule and reject input that would be changed."""
    url = require_http_url(value, name)
    hash_start = url.find("#")
    if hash_start >= 0 and not url[hash_start:].startswith(("#/", "#!")):
        raise QueryError(f"{name} must be a canonical HTTP(S) URL")
    return url


def require_image_source(value: Any, page_url: str, name: str) -> str:
    source = require_text(value, name, 8_192, allow_empty=False)
    if source.startswith("data:"):
        if not DATA_IMAGE.fullmatch(source):
            raise QueryError(f"{name} has an unsafe data image URL")
        return source
    if source.startswith("blob:"):
        blob = parse_url(source[5:], name)
        page = parse_url(page_url, name)
        if blob.scheme not in {"http", "https"} or not blob.netloc or (blob.scheme, blob.netloc) != (page.scheme, page.netloc):
            raise QueryError(f"{name} blob URL must belong to this page origin")
        return source
    return require_http_url(source, name)


def validate_tags(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 50:
        raise QueryError("annotation.tags must contain at most 50 tags")
    tags = [require_text(tag, f"annotation.tags[{index}]", 64, allow_empty=False) for index, tag in enumerate(value)]
    if len(tags) != len(set(tags)):
        raise QueryError("annotation.tags must not contain duplicates")
    return tags


def validate_point(value: Any, index: int) -> None:
    point = require_object(value, f"annotation.shape.points[{index}]")
    exact_keys(point, f"annotation.shape.points[{index}]", {"x", "y"}, {"pressure"})
    require_number(point["x"], f"annotation.shape.points[{index}].x", 0, 1)
    require_number(point["y"], f"annotation.shape.points[{index}].y", 0, 1)
    if "pressure" in point:
        require_number(point["pressure"], f"annotation.shape.points[{index}].pressure", 0, 1)


def validate_shape(value: Any) -> None:
    shape = require_object(value, "annotation.shape")
    exact_keys(shape, "annotation.shape", {"kind", "points", "width"})
    kind = shape["kind"]
    if not isinstance(kind, str) or kind not in {"rectangle", "ellipse", "arrow", "pen"}:
        raise QueryError("annotation.shape.kind is unsupported")
    points = shape["points"]
    if not isinstance(points, list):
        raise QueryError("annotation.shape.points must be an array")
    minimum, maximum = (1, 2_000) if kind == "pen" else (2, 2)
    if not minimum <= len(points) <= maximum:
        raise QueryError("annotation.shape.points count is invalid for its shape kind")
    for index, point in enumerate(points):
        validate_point(point, index)
    require_number(shape["width"], "annotation.shape.width", 0.0001, 1)


def validate_text_target(value: Any) -> None:
    target = require_object(value, "annotation.target")
    exact_keys(target, "annotation.target", {"exact", "prefix", "suffix", "start", "end", "rootSelector"}, {"containerId"})
    exact = require_text(target["exact"], "annotation.target.exact", 20_000, allow_empty=False)
    start = require_int(target["start"], "annotation.target.start", 0, 10_000_000)
    end = require_int(target["end"], "annotation.target.end", start, 10_000_000)
    if end - start != utf16_length(exact):
        raise QueryError("annotation.target exact text and offsets disagree")
    require_text(target["prefix"], "annotation.target.prefix", 10_000)
    require_text(target["suffix"], "annotation.target.suffix", 10_000)
    require_text(target["rootSelector"], "annotation.target.rootSelector", 2_048, allow_empty=False)
    if "containerId" in target:
        require_text(target["containerId"], "annotation.target.containerId", 512, allow_empty=False)


def validate_image_target(value: Any, page_url: str) -> None:
    target = require_object(value, "annotation.target")
    exact_keys(target, "annotation.target", {"src", "sourceCandidates", "alt", "naturalWidth", "naturalHeight", "selector", "occurrence", "context"})
    candidates = target["sourceCandidates"]
    if not isinstance(candidates, list) or len(candidates) > 20:
        raise QueryError("annotation.target.sourceCandidates must contain at most 20 sources")
    require_image_source(target["src"], page_url, "annotation.target.src")
    for index, source in enumerate(candidates):
        require_image_source(source, page_url, f"annotation.target.sourceCandidates[{index}]")
    require_text(target["alt"], "annotation.target.alt", 1_000)
    require_int(target["naturalWidth"], "annotation.target.naturalWidth", 1, 100_000)
    require_int(target["naturalHeight"], "annotation.target.naturalHeight", 1, 100_000)
    require_text(target["selector"], "annotation.target.selector", 2_048, allow_empty=False)
    require_int(target["occurrence"], "annotation.target.occurrence", 0, 100_000)
    require_text(target["context"], "annotation.target.context", 4_000)


def validate_rect(value: Any, index: int) -> None:
    rect = require_object(value, f"annotation.target.rects[{index}]")
    exact_keys(rect, f"annotation.target.rects[{index}]", {"x", "y", "width", "height"})
    x = require_number(rect["x"], f"annotation.target.rects[{index}].x", 0, 1)
    y = require_number(rect["y"], f"annotation.target.rects[{index}].y", 0, 1)
    width = require_number(rect["width"], f"annotation.target.rects[{index}].width", 0.000001, 1)
    height = require_number(rect["height"], f"annotation.target.rects[{index}].height", 0.000001, 1)
    if x + width > 1 or y + height > 1:
        raise QueryError(f"annotation.target.rects[{index}] exceeds the PDF page viewBox")


def validate_pdf_target(value: Any, annotation: dict[str, Any]) -> None:
    target = require_object(value, "annotation.target")
    exact_keys(target, "annotation.target", {"documentHash", "fileName", "pageNumber", "rects", "exact", "prefix", "suffix"}, {"sourceUrl"})
    document_hash = require_text(target["documentHash"], "annotation.target.documentHash", 64, allow_empty=False)
    if not HASH.fullmatch(document_hash):
        raise QueryError("annotation.target.documentHash must be a SHA-256 hex digest")
    if annotation["pageUrl"] != f"urn:web-ink:pdf:{document_hash.lower()}":
        raise QueryError("annotation.pageUrl must match the PDF document hash")
    require_text(target["fileName"], "annotation.target.fileName", 512, allow_empty=False)
    if "sourceUrl" in target:
        source_url = require_http_url(target["sourceUrl"], "annotation.target.sourceUrl")
        if not source_url.startswith("https:"):
            raise QueryError("annotation.target.sourceUrl must use HTTPS")
    require_int(target["pageNumber"], "annotation.target.pageNumber", 1, 100_000)
    rects = target["rects"]
    if not isinstance(rects, list) or not 1 <= len(rects) <= 500:
        raise QueryError("annotation.target.rects must contain 1 to 500 rectangles")
    for index, rect in enumerate(rects):
        validate_rect(rect, index)
    require_text(target["exact"], "annotation.target.exact", 20_000, allow_empty=annotation["kind"] == "pdf-area")
    require_text(target["prefix"], "annotation.target.prefix", 10_000)
    require_text(target["suffix"], "annotation.target.suffix", 10_000)


def validate_annotation(raw: Any, version: int) -> dict[str, Any]:
    annotation = require_object(raw, "annotation")
    exact_keys(annotation, "annotation", {"id", "pageUrl", "pageTitle", "color", "note", "tags", "createdAt", "updatedAt", "revision", "kind", "target"}, {"shape"})
    identifier = require_text(annotation["id"], "annotation.id", 128, allow_empty=False)
    if not IDENTIFIER.fullmatch(identifier):
        raise QueryError("annotation.id has an invalid format")
    kind = annotation["kind"]
    if not isinstance(kind, str) or kind not in KINDS:
        raise QueryError("annotation.kind is unsupported")
    if version == 1 and kind in {"pdf-text", "pdf-area"}:
        raise QueryError("schema v1 backup cannot contain PDF annotations")
    page_url = require_text(annotation["pageUrl"], "annotation.pageUrl", 128 if kind.startswith("pdf-") else 8_192, allow_empty=False)
    require_text(annotation["pageTitle"], "annotation.pageTitle", 500)
    color = require_text(annotation["color"], "annotation.color", 7, allow_empty=False)
    if not HEX_COLOR.fullmatch(color):
        raise QueryError("annotation.color must be a six-digit hex color")
    require_text(annotation["note"], "annotation.note", 10_000)
    validate_tags(annotation["tags"])
    created = parse_timestamp(annotation["createdAt"], "annotation.createdAt")
    updated = parse_timestamp(annotation["updatedAt"], "annotation.updatedAt")
    if updated < created:
        raise QueryError("annotation.updatedAt precedes createdAt")
    require_int(annotation["revision"], "annotation.revision", 0, MAX_REVISION)
    if kind == "text":
        require_canonical_page_url(page_url, "annotation.pageUrl")
        if "shape" in annotation:
            raise QueryError("text annotations cannot include shape")
        validate_text_target(annotation["target"])
    elif kind == "image":
        require_canonical_page_url(page_url, "annotation.pageUrl")
        if "shape" not in annotation:
            raise QueryError("image annotations require shape")
        validate_image_target(annotation["target"], page_url)
        validate_shape(annotation["shape"])
    else:
        if "shape" in annotation:
            raise QueryError("PDF annotations cannot include shape")
        validate_pdf_target(annotation["target"], annotation)
    return annotation


def require_document_hash(value: Any, name: str) -> str:
    document_hash = require_text(value, name, 64, allow_empty=False)
    if not HASH.fullmatch(document_hash) or document_hash != document_hash.lower():
        raise QueryError(f"{name} must be a lowercase SHA-256 hex digest")
    return document_hash


def validate_native_time_fields(record: dict[str, Any], name: str) -> None:
    if "createdAt" in record:
        parse_timestamp(record["createdAt"], f"{name}.createdAt")
    if "updatedAt" in record:
        parse_timestamp(record["updatedAt"], f"{name}.updatedAt")


def validate_native_rect(value: Any, name: str) -> None:
    if not isinstance(value, list) or len(value) != 4:
        raise QueryError(f"{name} must contain [left, bottom, right, top]")
    left, bottom, right, top = (
        require_number(component, f"{name}[{index}]", -10_000_000, 10_000_000)
        for index, component in enumerate(value)
    )
    if right < left or top < bottom:
        raise QueryError(f"{name} coordinates are out of order")


def validate_native_color(value: Any, name: str) -> None:
    if not isinstance(value, list) or len(value) != 3:
        raise QueryError(f"{name} must contain three PDF.js RGB bytes")
    for index, component in enumerate(value):
        require_int(component, f"{name}[{index}]", 0, 255)


def validate_native_reply(raw: Any, name: str) -> dict[str, Any]:
    reply = require_object(raw, name)
    exact_keys(reply, name, {"id", "subtype", "contents"}, {"author", "createdAt", "updatedAt", "inReplyTo", "replyType"})
    require_text(reply["id"], f"{name}.id", 512, allow_empty=False)
    require_text(reply["subtype"], f"{name}.subtype", 64, allow_empty=False)
    require_text(reply["contents"], f"{name}.contents", MAX_NATIVE_CONTENTS)
    if "author" in reply:
        require_text(reply["author"], f"{name}.author", MAX_NATIVE_AUTHOR)
    if "inReplyTo" in reply:
        require_text(reply["inReplyTo"], f"{name}.inReplyTo", 512, allow_empty=False)
    if "replyType" in reply:
        require_text(reply["replyType"], f"{name}.replyType", 64, allow_empty=False)
    validate_native_time_fields(reply, name)
    return reply


def validate_native_annotation(raw: Any, document_hash: str, index: int) -> dict[str, Any]:
    name = f"nativeAnnotations[{index}]"
    annotation = require_object(raw, name)
    exact_keys(
        annotation,
        name,
        {"key", "documentHash", "pageNumber", "id", "subtype", "contents"},
        {"author", "createdAt", "updatedAt", "inReplyTo", "replyType", "rect", "color", "replies"},
    )
    key = require_text(annotation["key"], f"{name}.key", 600, allow_empty=False)
    if require_document_hash(annotation["documentHash"], f"{name}.documentHash") != document_hash:
        raise QueryError(f"{name}.documentHash must match document.documentHash")
    require_int(annotation["pageNumber"], f"{name}.pageNumber", 1, 100_000)
    annotation_id = require_text(annotation["id"], f"{name}.id", 512, allow_empty=False)
    require_text(annotation["subtype"], f"{name}.subtype", 64, allow_empty=False)
    require_text(annotation["contents"], f"{name}.contents", MAX_NATIVE_CONTENTS)
    expected_key = f"{document_hash}:{annotation['pageNumber']}:{annotation_id}"
    if key != expected_key:
        raise QueryError(f"{name}.key must match documentHash, pageNumber, and id")
    if "author" in annotation:
        require_text(annotation["author"], f"{name}.author", MAX_NATIVE_AUTHOR)
    if "inReplyTo" in annotation:
        require_text(annotation["inReplyTo"], f"{name}.inReplyTo", 512, allow_empty=False)
    if "replyType" in annotation:
        require_text(annotation["replyType"], f"{name}.replyType", 64, allow_empty=False)
    validate_native_time_fields(annotation, name)
    if "rect" in annotation:
        validate_native_rect(annotation["rect"], f"{name}.rect")
    if "color" in annotation:
        validate_native_color(annotation["color"], f"{name}.color")
    if "replies" in annotation:
        replies = annotation["replies"]
        if not isinstance(replies, list) or len(replies) > MAX_NATIVE_REPLIES:
            raise QueryError(f"{name}.replies must contain at most {MAX_NATIVE_REPLIES} records")
        for reply_index, reply in enumerate(replies):
            validate_native_reply(reply, f"{name}.replies[{reply_index}]")
    return annotation


def reject_json_constant(value: str) -> None:
    raise QueryError(f"export contains unsupported JSON number: {value}")


def read_export(path: Path) -> bytes:
    try:
        initial = path.lstat()
    except OSError as error:
        raise QueryError(f"cannot read export: {error.strerror or error}") from error
    if not stat.S_ISREG(initial.st_mode):
        raise QueryError("--file must name a regular file, not a link or directory")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise QueryError("--file must name a regular file, not a link or directory")
            payload = handle.read(MAX_BYTES + 1)
    except QueryError:
        raise
    except OSError as error:
        raise QueryError(f"cannot read export: {error.strerror or error}") from error
    if len(payload) > MAX_BYTES:
        raise QueryError("export exceeds the 20 MiB limit")
    return payload


def parse_export_file(file_name: str) -> dict[str, Any]:
    path = Path(file_name)
    if not path.is_absolute():
        raise QueryError("--file must be an absolute path")
    try:
        backup = json.loads(read_export(path).decode("utf-8"), parse_constant=reject_json_constant)
    except QueryError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise QueryError(f"export is not valid UTF-8 JSON: {error}") from error
    return require_object(backup, "backup")


def validate_backup(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    exact_keys(envelope, "backup", {"format", "schemaVersion", "exportedAt", "annotations"}, {"settings"})
    if envelope["format"] != "web-ink":
        raise QueryError("backup.format must be web-ink")
    version = envelope["schemaVersion"]
    if type(version) is not int or version not in {1, 2}:
        raise QueryError("backup.schemaVersion must be 1 or 2")
    parse_timestamp(envelope["exportedAt"], "backup.exportedAt")
    annotations = envelope["annotations"]
    if not isinstance(annotations, list) or len(annotations) > MAX_ANNOTATIONS:
        raise QueryError("backup.annotations must contain at most 50,000 records")
    records = [validate_annotation(item, version) for item in annotations]
    ids = [annotation["id"] for annotation in records]
    if len(ids) != len(set(ids)):
        raise QueryError("backup.annotations contains duplicate IDs")
    return records


def load_backup(file_name: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    envelope = parse_export_file(file_name)
    return envelope, validate_backup(envelope)


def validate_pdf_notes(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    exact_keys(
        envelope,
        "pdf notes",
        {"format", "schemaVersion", "exportedAt", "document", "annotations", "nativeAnnotations"},
    )
    if envelope["format"] != "web-ink-pdf-notes":
        raise QueryError("pdf notes.format must be web-ink-pdf-notes")
    if type(envelope["schemaVersion"]) is not int or envelope["schemaVersion"] != 1:
        raise QueryError("pdf notes.schemaVersion must be 1")
    parse_timestamp(envelope["exportedAt"], "pdf notes.exportedAt")
    document = require_object(envelope["document"], "pdf notes.document")
    exact_keys(document, "pdf notes.document", {"documentHash", "fileName"}, {"sourceUrl"})
    document_hash = require_document_hash(document["documentHash"], "pdf notes.document.documentHash")
    require_text(document["fileName"], "pdf notes.document.fileName", 512, allow_empty=False)
    if "sourceUrl" in document:
        source_url = require_http_url(document["sourceUrl"], "pdf notes.document.sourceUrl")
        if not source_url.startswith("https:"):
            raise QueryError("pdf notes.document.sourceUrl must use HTTPS")

    annotations = envelope["annotations"]
    native_annotations = envelope["nativeAnnotations"]
    if not isinstance(annotations, list) or not isinstance(native_annotations, list):
        raise QueryError("pdf notes annotations and nativeAnnotations must be arrays")
    if len(annotations) + len(native_annotations) > MAX_ANNOTATIONS:
        raise QueryError("pdf notes contains more than 50,000 records")

    web_records = [validate_annotation(annotation, 2) for annotation in annotations]
    for index, annotation in enumerate(web_records):
        if annotation["kind"] not in {"pdf-text", "pdf-area"}:
            raise QueryError(f"annotations[{index}] must be a PDF Web Ink record")
        if annotation["target"]["documentHash"] != document_hash:
            raise QueryError(f"annotations[{index}].target.documentHash must match document.documentHash")
    native_records = [
        validate_native_annotation(annotation, document_hash, index)
        for index, annotation in enumerate(native_annotations)
    ]

    query_ids = [f"web:{annotation['id']}" for annotation in web_records]
    query_ids.extend(f"native:{annotation['key']}" for annotation in native_records)
    if len(query_ids) != len(set(query_ids)):
        raise QueryError("pdf notes contains duplicate query IDs")
    return web_records + native_records


def load_pdf_notes(file_name: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    envelope = parse_export_file(file_name)
    return envelope, validate_pdf_notes(envelope)


def load_export(file_name: str) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    envelope = parse_export_file(file_name)
    export_format = envelope.get("format")
    if export_format == "web-ink":
        return envelope, validate_backup(envelope), False
    if export_format == "web-ink-pdf-notes":
        return envelope, validate_pdf_notes(envelope), True
    raise QueryError("export.format is unsupported")


def source_url(annotation: dict[str, Any]) -> str | None:
    return annotation["target"].get("sourceUrl") if annotation["kind"] in {"pdf-text", "pdf-area"} else annotation["pageUrl"]


def citation(annotation: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"annotationId": annotation["id"], "title": annotation["pageTitle"], "sourceUrl": source_url(annotation), "createdAt": annotation["createdAt"]}
    if annotation["kind"] in {"pdf-text", "pdf-area"}:
        result.update({"fileName": annotation["target"]["fileName"], "pageNumber": annotation["target"]["pageNumber"]})
    return result


def native_annotation_view(annotation: dict[str, Any], document: dict[str, Any]) -> dict[str, Any]:
    created_at = annotation.get("createdAt")
    result: dict[str, Any] = {
        "id": f"native:{annotation['key']}",
        "recordType": "native-pdf",
        "key": annotation["key"],
        "nativeAnnotationId": annotation["id"],
        "subtype": annotation["subtype"],
        "contents": annotation["contents"],
        "createdAt": created_at,
        "createdAtKnown": created_at is not None,
        "updatedAt": annotation.get("updatedAt"),
        "updatedAtKnown": "updatedAt" in annotation,
        "citation": {
            "annotationId": annotation["id"],
            "title": document["fileName"],
            "sourceUrl": document.get("sourceUrl"),
            "documentHash": document["documentHash"],
            "pageNumber": annotation["pageNumber"],
            "createdAt": created_at,
            "createdAtKnown": created_at is not None,
            "updatedAt": annotation.get("updatedAt"),
            "updatedAtKnown": "updatedAt" in annotation,
        },
        "originalFile": {
            "documentHash": document["documentHash"],
            "fileName": document["fileName"],
            "sourceUrl": document.get("sourceUrl"),
            "pageNumber": annotation["pageNumber"],
        },
        "readOnly": True,
        "contentBoundary": "Contents are original PDF annotation text, not a reconstructed source excerpt.",
    }
    for field in ("author", "inReplyTo", "replyType", "rect", "color", "replies"):
        if field in annotation:
            result[field] = annotation[field]
    return result


def annotation_view(annotation: dict[str, Any], *, standalone: bool = False, document: dict[str, Any] | None = None) -> dict[str, Any]:
    if standalone and "key" in annotation:
        if document is None:
            raise QueryError("native annotation is missing document provenance")
        return native_annotation_view(annotation, document)
    target = annotation["target"]
    result: dict[str, Any] = {"id": f"web:{annotation['id']}" if standalone else annotation["id"], "kind": annotation["kind"], "title": annotation["pageTitle"], "pageUrl": annotation["pageUrl"], "userNote": annotation["note"], "tags": annotation["tags"], "createdAt": annotation["createdAt"], "citation": citation(annotation)}
    if annotation["kind"] == "text":
        result.update({"savedExcerpt": target["exact"], "context": {"prefix": target["prefix"], "suffix": target["suffix"]}})
    elif annotation["kind"] == "image":
        result.update({"savedExcerpt": None, "image": {"src": target["src"], "sourceCandidates": target["sourceCandidates"], "alt": target["alt"], "context": target["context"]}, "shape": annotation["shape"], "noOcrText": True, "contentBoundary": "No OCR text is available; image context and shape are saved annotation metadata."})
    else:
        result.update({"pdf": {"fileName": target["fileName"], "pageNumber": target["pageNumber"], "sourceUrl": target.get("sourceUrl")}, "shape": {"rects": target["rects"]}})
        if annotation["kind"] == "pdf-text":
            result.update({"savedExcerpt": target["exact"], "context": {"prefix": target["prefix"], "suffix": target["suffix"]}})
        else:
            result.update({"savedExcerpt": None, "noOcrText": True, "contentBoundary": "No OCR text is available; this is a saved PDF region, not a description of its contents."})
    return result


def searchable_text(annotation: dict[str, Any]) -> str:
    if "key" in annotation:
        fields = [
            annotation["key"], annotation["id"], annotation["subtype"], annotation["contents"],
            annotation.get("author", ""), annotation.get("inReplyTo", ""), annotation.get("replyType", ""),
        ]
        for reply in annotation.get("replies", []):
            fields.extend([reply["id"], reply["subtype"], reply["contents"], reply.get("author", ""), reply.get("inReplyTo", ""), reply.get("replyType", "")])
        return "\n".join(fields).casefold()
    target = annotation["target"]
    fields = [annotation["pageTitle"], annotation["pageUrl"], annotation["note"], *annotation["tags"]]
    if annotation["kind"] == "text":
        fields.extend([target["exact"], target["prefix"], target["suffix"]])
    elif annotation["kind"] == "image":
        fields.extend([target["src"], *target["sourceCandidates"], target["alt"], target["context"]])
    else:
        fields.extend([target["fileName"], target.get("sourceUrl", ""), target["exact"], target["prefix"], target["suffix"]])
    return "\n".join(fields).casefold()


def parse_nonnegative(value: str, name: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise QueryError(f"{name} must be a non-negative integer") from error
    if result < 0:
        raise QueryError(f"{name} must be a non-negative integer")
    return result


def document_summaries(annotations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], dict[str, Any]] = {}
    for annotation in annotations:
        if annotation["kind"] in {"pdf-text", "pdf-area"}:
            target = annotation["target"]
            key = ("pdf", annotation["pageUrl"], target["documentHash"])
            document = groups.setdefault(key, {
                "title": annotation["pageTitle"],
                "pageUrl": annotation["pageUrl"],
                "sourceUrl": target.get("sourceUrl"),
                "fileName": target["fileName"],
                "documentHash": target["documentHash"],
                "count": 0,
            })
        else:
            key = ("web", annotation["pageUrl"])
            document = groups.setdefault(key, {
                "title": annotation["pageTitle"],
                "pageUrl": annotation["pageUrl"],
                "sourceUrl": annotation["pageUrl"],
                "count": 0,
            })
        document["count"] += 1
    return sorted(groups.values(), key=lambda document: (document["pageUrl"], document.get("documentHash", "")))


def inspect(envelope: dict[str, Any], annotations: list[dict[str, Any]], *, standalone: bool = False) -> dict[str, Any]:
    if standalone:
        counts = Counter("native-pdf" if "key" in annotation else annotation["kind"] for annotation in annotations)
        known_times = [annotation["createdAt"] for annotation in annotations if annotation.get("createdAt")]
        first = min(known_times, key=lambda value: parse_timestamp(value, "annotation.createdAt"), default=None)
        last = max(known_times, key=lambda value: parse_timestamp(value, "annotation.createdAt"), default=None)
        return {
            "format": "web-ink-pdf-notes",
            "schemaVersion": envelope["schemaVersion"],
            "exportedAt": envelope["exportedAt"],
            "document": envelope["document"],
            "total": len(annotations),
            "countsByKind": {kind: counts[kind] for kind in sorted(counts)},
            "createdAtRange": {"from": first, "to": last},
            "unknownCreatedAtCount": len(annotations) - len(known_times),
            "coverage": "This is a read-only current-PDF notes snapshot, not an importable Web Ink backup. Native contents are original annotation text, not reconstructed excerpts.",
        }
    counts = Counter(annotation["kind"] for annotation in annotations)
    first = min(annotations, key=lambda annotation: parse_timestamp(annotation["createdAt"], "annotation.createdAt"), default=None)
    last = max(annotations, key=lambda annotation: parse_timestamp(annotation["createdAt"], "annotation.createdAt"), default=None)
    return {"format": "web-ink", "schemaVersion": envelope["schemaVersion"], "exportedAt": envelope["exportedAt"], "total": len(annotations), "countsByKind": {kind: counts[kind] for kind in sorted(KINDS)}, "documents": document_summaries(annotations), "createdAtRange": {"from": first["createdAt"] if first else None, "to": last["createdAt"] if last else None}, "coverage": "Counts and time range describe only this selected export. Annotations are excerpts and notes, not full document text."}


def search(
    args: argparse.Namespace,
    annotations: list[dict[str, Any]],
    *,
    standalone: bool = False,
    document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    limit = parse_nonnegative(args.limit, "--limit")
    offset = parse_nonnegative(args.offset, "--offset")
    if not 1 <= limit <= 100:
        raise QueryError("--limit must be between 1 and 100")
    kinds = KINDS | ({"native-pdf"} if standalone else set())
    if args.kind and args.kind not in kinds:
        raise QueryError("--kind is unsupported")
    start = parse_timestamp(args.from_time, "--from") if args.from_time else None
    end = parse_timestamp(args.to_time, "--to") if args.to_time else None
    if start and end and start > end:
        raise QueryError("--from must not be after --to")
    query = args.text.casefold()
    matching: list[tuple[datetime | None, dict[str, Any]]] = []
    for annotation in annotations:
        native = "key" in annotation
        kind = "native-pdf" if native else annotation["kind"]
        created = parse_timestamp(annotation["createdAt"], "annotation.createdAt") if annotation.get("createdAt") else None
        if args.kind and kind != args.kind:
            continue
        if args.tag and (native or args.tag not in annotation["tags"]):
            continue
        if (start or end) and created is None:
            continue
        if (start and created and created < start) or (end and created and created > end):
            continue
        haystack = searchable_text(annotation)
        if native and document:
            haystack = "\n".join([haystack, document["fileName"], document.get("sourceUrl", "")]).casefold()
        if query not in haystack:
            continue
        matching.append((created, annotation))
    matching.sort(
        key=lambda item: (
            item[0] is not None,
            item[0].timestamp() if item[0] else float("-inf"),
            f"native:{item[1]['key']}" if "key" in item[1] else f"web:{item[1]['id']}",
        ),
        reverse=True,
    )
    page = matching[offset:offset + limit]
    return {"total": len(matching), "offset": offset, "limit": limit, "hasMore": offset + len(page) < len(matching), "items": [annotation_view(annotation, standalone=standalone, document=document) for _, annotation in page]}


def show(
    annotation_id: str,
    annotations: list[dict[str, Any]],
    *,
    standalone: bool = False,
    document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    for annotation in annotations:
        candidate = (
            f"native:{annotation['key']}" if "key" in annotation else f"web:{annotation['id']}"
        ) if standalone else annotation["id"]
        if candidate == annotation_id:
            return annotation_view(annotation, standalone=standalone, document=document)
    raise QueryError("annotation ID was not found in this export")


def parser() -> JsonArgumentParser:
    result = JsonArgumentParser(description="Read one selected Web Ink JSON export.")
    commands = result.add_subparsers(dest="command", required=True)
    for name in ("inspect", "search", "show"):
        command = commands.add_parser(name)
        command.add_argument("--file", required=True)
    search_command = commands.choices["search"]
    search_command.add_argument("--text", required=True)
    search_command.add_argument("--kind")
    search_command.add_argument("--tag")
    search_command.add_argument("--from", dest="from_time")
    search_command.add_argument("--to", dest="to_time")
    search_command.add_argument("--offset", default="0")
    search_command.add_argument("--limit", default="20")
    commands.choices["show"].add_argument("--id", required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        envelope, annotations, standalone = load_export(args.file)
        document = envelope.get("document") if standalone else None
        if args.command == "inspect":
            output(inspect(envelope, annotations, standalone=standalone))
        elif args.command == "search":
            output(search(args, annotations, standalone=standalone, document=document))
        else:
            output(show(args.id, annotations, standalone=standalone, document=document))
        return 0
    except QueryError as error:
        output({"error": str(error)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
