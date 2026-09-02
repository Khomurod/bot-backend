/**
 * Shared message-composer building blocks — RE-EXPORT ONLY.
 *
 * Six pages import from this path, so it stays the stable seam while each
 * piece lives in a focused module:
 *
 *   ./shared/TelegramPreview.jsx       how the message will look in Telegram
 *   ./shared/MediaUploader.jsx         attachments + the browser-side downscale
 *   ./shared/useFormattingToolbar.jsx  bold / italic / link over a textarea
 *
 * The birthday helpers are re-exported from ../utils/ purely for compatibility:
 * they are pure date maths with no UI, and GroupsPage/CompanyBirthdaysPage
 * happened to reach them through here.
 *
 * Nothing but re-exports belongs in this file.
 */
export {
  getDaysUntilBirthday,
  sortBySoonestBirthday,
  parseDriverNameFromGroupTitle,
} from "../utils/birthdaySort.js";

export { TelegramPreview } from "./shared/TelegramPreview";
export { MediaUploader, MediaPositionSelector } from "./shared/MediaUploader";
export { useFormattingToolbar } from "./shared/useFormattingToolbar";
