// Minimal ambient types for node-canvas, used only when the canvas package is
// not installed locally (e.g. on macOS dev box without Homebrew prereqs).
//
// On the Pi, canvas IS installed and brings its own real type definitions in
// node_modules/canvas/types — those take precedence and this stub is ignored.
//
// We only need to declare the surface we actually call (createCanvas,
// loadImage, createImageData, plus the types referenced in our render code).

declare module "canvas" {
  export interface ImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  }

  export interface Image {
    width: number;
    height: number;
    src: any;
  }

  export interface CanvasRenderingContext2D {
    fillStyle: string | CanvasGradient | CanvasPattern;
    fillRect(x: number, y: number, w: number, h: number): void;
    save(): void;
    restore(): void;
    beginPath(): void;
    closePath(): void;
    arc(
      x: number,
      y: number,
      r: number,
      start: number,
      end: number,
      counterclockwise?: boolean,
    ): void;
    clip(): void;
    drawImage(image: any, dx: number, dy: number): void;
    drawImage(
      image: any,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
    drawImage(
      image: any,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
    getImageData(x: number, y: number, w: number, h: number): ImageData;
    putImageData(image: ImageData, x: number, y: number): void;
    clearRect(x: number, y: number, w: number, h: number): void;
  }

  export interface Canvas {
    width: number;
    height: number;
    getContext(type: "2d"): CanvasRenderingContext2D;
  }

  export interface CanvasGradient {}
  export interface CanvasPattern {}

  export function createCanvas(width: number, height: number): Canvas;
  export function loadImage(src: string | Buffer): Promise<Image>;
  export function createImageData(
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ): ImageData;
}
