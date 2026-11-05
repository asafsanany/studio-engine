/**
 * Which layout a part of the job sheet is drawn for. The Mac's sheet is the default; the phone's
 * bottom sheet (`PhoneJobSheet`) asks for `phone` where its boards differ (canvas page Mobile),
 * and every rule, request and word stays the part's own.
 */
export type SheetVariant = 'mac' | 'phone';
