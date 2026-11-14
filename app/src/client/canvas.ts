/**
 * Returns the single stable game canvas declared in index.html. It lives outside React's tree so
 * re-renders can never recreate it; the renderer (later task) owns it.
 * @throws if the canvas is missing, which means index.html and the client have drifted apart.
 */
export function getDriftCanvas(doc: Document = document): HTMLCanvasElement {
  const canvas = doc.getElementById('drift-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Missing <canvas id="drift-canvas"> in index.html');
  }
  return canvas;
}
