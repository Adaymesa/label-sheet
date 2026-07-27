import { describe, it, expect } from 'vitest';
import { barcodeSvg } from './barcodeSvg.js';
import { encode, decode } from './code128.js';

/** Recover element widths from the drawn bars, so we can prove the SVG is scannable. */
function widthsFromSvg(svg: string, quietZone = 10): number[] {
  const bars = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)" height="10" \/>/g)].map(
    (m) => ({ x: Number(m[1]), width: Number(m[2]) }),
  );

  const widths: number[] = [];
  let cursor = quietZone;
  for (const bar of bars) {
    if (bar.x > cursor) widths.push(bar.x - cursor); // the space before this bar
    widths.push(bar.width);
    cursor = bar.x + bar.width;
  }
  return widths;
}

describe('barcodeSvg', () => {
  it('draws bars that decode back to the tracking number', () => {
    const { svg } = barcodeSvg('LX554474175ES');
    expect(widthsFromSvg(svg)).toEqual(encode('LX554474175ES'));
    expect(decode(widthsFromSvg(svg))).toBe('LX554474175ES');
  });

  it('leaves a 10-module quiet zone on both sides', () => {
    const { svg } = barcodeSvg('LX554474175ES');
    const viewBox = /viewBox="0 0 (\d+) 10"/.exec(svg)?.[1];
    const symbolModules = encode('LX554474175ES').reduce((a, b) => a + b, 0);

    expect(Number(viewBox)).toBe(symbolModules + 20);
    expect(svg).toContain('<rect x="10" y="0"'); // first bar starts after the quiet zone
  });

  it('sizes itself physically so a counter scanner can read it', () => {
    const { widthMm, heightMm } = barcodeSvg('LX554474175ES');
    expect(widthMm).toBeCloseTo(88, 1); // 176 modules at 0.5mm
    expect(heightMm).toBe(16);
  });

  it('honours a custom module width', () => {
    const { widthMm } = barcodeSvg('LX554474175ES', { moduleMm: 0.4 });
    expect(widthMm).toBeCloseTo(70.4, 1);
  });

  it('keeps every S10 code the same width, so rows line up', () => {
    expect(barcodeSvg('LX554474175ES').widthMm).toBe(barcodeSvg('EJ520253722ES').widthMm);
  });

  it('labels the symbol for screen readers', () => {
    expect(barcodeSvg('LX554474175ES').svg).toContain('aria-label="LX554474175ES"');
  });
});
