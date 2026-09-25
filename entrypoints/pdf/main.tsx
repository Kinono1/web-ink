import { createRoot } from "react-dom/client";
import { PdfReader } from "../../src/pdf/PdfReader";
import { installPageTheme } from "../../src/ui/page-theme";
installPageTheme();
createRoot(document.getElementById("root")!).render(<PdfReader />);
