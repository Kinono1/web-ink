import type { PdfAnnotation, SelectionTarget } from "../../core/pdf-types";
import { PdfPage } from "../PdfPage";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfPageBindings } from "../hooks/useViewport";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = { state: ReaderSnapshot; actions: ReaderActions };

const EMPTY_RECORDS: PdfAnnotation[] = [];

export function PdfCanvas({ state, actions, recoveryArea, onRecoveryArea }: Props & {
  recoveryArea?: { target: SelectionTarget; color: string };
  onRecoveryArea?: (target: SelectionTarget) => void;
}) {
  const {
    area, color, container, dimensions, layoutIndex, locked, measurementGeneration, pageWindow,
    recordsByPage, rotation, searchMatch, showMarks, zoom,
  } = state;
  const { receiveOriginalNotes, userIntent } = actions;
  const pageBindings = usePdfPageBindings(state, actions);
  const opened = usePdfDocument();
  const { language, t } = usePdfUI();
  if (!opened) return null;
  return (<div className="pdf-pages" tabIndex={0} ref={container} aria-label={t("PDF 页面", "PDF pages")}
    onWheelCapture={userIntent} onPointerDownCapture={userIntent}
    onKeyDownCapture={(event) => { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) userIntent(); }}>
    <div aria-hidden="true" style={{ height: layoutIndex.current.offsetBefore(pageWindow.start + 1) }} />
    {Array.from({ length: Math.min(pageWindow.end, opened.document.numPages) - pageWindow.start }, (_, index) => index + pageWindow.start + 1).map((number) => (
      <div className="pdf-slot" data-page={number} key={`${opened.hash}-${number}`} style={{
        width: dimensions.current.get(number)?.width || (rotation % 180 ? 792 : 612) * zoom,
        height: dimensions.current.get(number)?.height || (rotation % 180 ? 612 : 792) * zoom,
      }}>
        <PdfPage language={language} opened={opened} number={number} zoom={zoom} rotation={rotation} records={showMarks ? recordsByPage.get(number) ?? EMPTY_RECORDS : EMPTY_RECORDS}
          onNativeRecords={receiveOriginalNotes}
          searchRanges={searchMatch?.pageNumber === number ? searchMatch.itemRanges : undefined}
          area={area && !locked} color={color} measurementGeneration={measurementGeneration}
          {...pageBindings(number)}
          {...(onRecoveryArea ? { onArea: (target: SelectionTarget) => {
            if (state.documentSession === state.documentSessionRef.current && !locked) onRecoveryArea(target);
          } } : {})}
          recoveryPreview={recoveryArea?.target.pageNumber === number && recoveryArea.target.rects[0]
            ? { rect: recoveryArea.target.rects[0], color: recoveryArea.color } : undefined} />
      </div>
    ))}
    <div aria-hidden="true" style={{ height: Math.max(0, layoutIndex.current.totalHeight() - layoutIndex.current.offsetBefore(Math.min(pageWindow.end, opened.document.numPages) + 1)) }} />
  </div>);
}
