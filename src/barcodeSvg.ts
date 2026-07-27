/**
 * Renders a Code 128 symbol as SVG markup, sized in millimetres so it prints at a
 * physical size a counter scanner can read.
 *
 * Pure string building — no DOM, so it is testable and reusable outside the browser.
 */
import { encode } from './code128.js';

export interface BarcodeOptions {
  /** Width of one module (the narrowest bar) in mm. Correos prints ~0.45mm. */
  readonly moduleMm?: number;
  /** Bar height in mm. */
  readonly heightMm?: number;
}

/** Code 128 requires a clear margin of at least 10 modules on each side. */
const QUIET_ZONE_MODULES = 10;

const DEFAULT_MODULE_MM = 0.5;

/**
 * 16mm of bar height. Well above what a counter scanner needs, and short enough to fit
 * two columns of 8 parcels on an A4 page.
 */
const DEFAULT_HEIGHT_MM = 16;

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Barcode {
  readonly svg: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export function barcodeSvg(data: string, options: BarcodeOptions = {}): Barcode {
  const moduleMm = options.moduleMm ?? DEFAULT_MODULE_MM;
  const heightMm = options.heightMm ?? DEFAULT_HEIGHT_MM;

  const widths = encode(data);
  const symbolModules = widths.reduce((a, b) => a + b, 0);
  const totalModules = symbolModules + QUIET_ZONE_MODULES * 2;

  // Draw in module units and let the viewBox scale to mm, so bar edges stay exact.
  const bars: string[] = [];
  let cursor = QUIET_ZONE_MODULES;
  widths.forEach((width, index) => {
    if (index % 2 === 0) {
      bars.push(`<rect x="${cursor}" y="0" width="${width}" height="10" />`);
    }
    cursor += width;
  });

  const widthMm = totalModules * moduleMm;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeAttr(data)}" ` +
    `width="${widthMm}mm" height="${heightMm}mm" ` +
    `viewBox="0 0 ${totalModules} 10" preserveAspectRatio="none" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${totalModules}" height="10" fill="#fff" />` +
    `<g fill="#000">${bars.join('')}</g>` +
    `</svg>`;

  return { svg, widthMm, heightMm };
}
