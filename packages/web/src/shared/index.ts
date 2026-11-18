export {
  DEFAULT_FOCUSABLE_SELECTOR,
  trapTabFocus,
  useFocusTrap,
  type UseFocusTrapOptions,
} from './hooks/useFocusTrap.js';
export { useEscapeKey } from './hooks/useEscapeKey.js';
export { handleMenuArrowNavigation } from './hooks/useMenuKeyboardNav.js';
export {
  calculateSidebarDropdownPosition,
  calculateViewportMenuPosition,
  type ViewportPlacementParams,
} from './lib/overlay-position.js';
export { BannerNotice, type BannerNoticeProps } from './ui/BannerNotice.js';
export { ConfirmDialog, type ConfirmDialogProps } from './ui/ConfirmDialog.js';
export { InlineRenameInput, type InlineRenameInputProps } from './ui/InlineRenameInput.js';
export { ModalDialog, type ModalDialogProps } from './ui/ModalDialog.js';
export { StatusDot, type StatusDotProps, type StatusDotTone } from './ui/StatusDot.js';
