/** Domain types. No IO, no framework, no pdf.js. */

/** A run of text on a page, positioned in y-down point space (origin top-left). */
export interface PositionedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfPageText {
  readonly width: number;
  readonly height: number;
  readonly items: readonly PositionedText[];
}

/** One parcel, as it will appear on the printed sheet. */
export interface Label {
  /** S10 tracking number, e.g. "LX554474175ES". This is what the barcode encodes. */
  readonly tracking: string;
  readonly recipient: string;
  readonly destination: string;
  /** As printed on the label, e.g. "0,07 kg". Null when the label does not state one. */
  readonly weight: string | null;
  /** File the label came from, for error messages and de-duplication. */
  readonly sourceName: string;
}

/**
 * Extraction never throws on unrecognised input: a label we cannot read must be reported
 * to the user, not silently dropped from the sheet.
 */
export type ExtractionResult =
  | { readonly ok: true; readonly label: Label }
  | { readonly ok: false; readonly sourceName: string; readonly reason: string };
