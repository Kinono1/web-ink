import { createRoot } from "react-dom/client";
import { PdfReader } from "../../src/pdf/PdfReader";
import { installPageTheme } from "../../src/core/theme";
installPageTheme();
createRoot(document.getElementById("root")!).render(<PdfReader />);
