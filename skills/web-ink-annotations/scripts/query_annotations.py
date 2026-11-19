#!/usr/bin/env python3
"""Read one selected Web Ink JSON export without changing it or using a service."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from typing import Any

from annotation_export import KINDS, QueryError, load_export, parse_timestamp


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise QueryError(message)


def output(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


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
