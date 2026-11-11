/** Pixel processing stays in the administrator's browser; no image URL or upload API. */
export async function receiptContrastImage(
  file: File,
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 20_000_000)
      throw new Error("图片超过 2000 万像素，请缩小后重试");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("浏览器不支持本机图片处理");
    ctx.filter = "blur(1px)";
    ctx.drawImage(bitmap, 0, 0);
    ctx.filter = "none";
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const value =
        0.299 * pixels.data[i] +
          0.587 * pixels.data[i + 1] +
          0.114 * pixels.data[i + 2] <
        115
          ? 0
          : 255;
      pixels.data[i] = value;
      pixels.data[i + 1] = value;
      pixels.data[i + 2] = value;
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}
