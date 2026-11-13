const MAX_UPLOAD = 2 * 1024 * 1024,
  MAX_IMAGE_SOURCE = 20 * 1024 * 1024;
const asBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(Error("图片压缩失败，请重试。")),
      "image/jpeg",
      quality,
    ),
  );
function named(file: File, ext: string): File {
  const base =
    file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[\/\\\x00-\x1f]/g, "_")
      .slice(0, 110) || "receipt";
  const name = base + ext;
  return file.name === name
    ? file
    : new File([file], name, {
        type: file.type,
        lastModified: file.lastModified,
      });
}
export async function prepareReceipt(file: File): Promise<File> {
  if (file.type === "application/pdf") {
    if (file.size > MAX_UPLOAD)
      throw Error("PDF 最大支持 2 MB，请选择较小的文件。");
    return named(file, ".pdf");
  }
  if (!["image/png", "image/jpeg"].includes(file.type))
    throw Error("请选择 PNG、JPG 或 PDF 回单。");
  if (file.size > MAX_IMAGE_SOURCE)
    throw Error("图片过大，请选择 20 MB 以内的回单。");
  const url = URL.createObjectURL(file),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    const { naturalWidth: w, naturalHeight: h } = image;
    if (!w || !h) throw Error("图片无法读取。");
    let scale = Math.min(
      1,
      2000 / w,
      12000 / h,
      Math.sqrt(16_000_000 / (w * h)),
    );
    const canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d");
    if (!ctx) throw Error("当前浏览器无法处理图片，请更换浏览器。");
    let candidate: Blob | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.8, 0.72]) {
        candidate = await asBlob(canvas, quality);
        if (candidate.size <= 1_400_000) break;
      }
      if (candidate && candidate.size <= MAX_UPLOAD) break;
      if (canvas.width <= 1000) break;
      scale *= 0.85;
    }
    if (
      scale === 1 &&
      file.size <= MAX_UPLOAD &&
      candidate &&
      file.size <= candidate.size
    )
      return named(file, file.type === "image/png" ? ".png" : ".jpg");
    if (!candidate || candidate.size > MAX_UPLOAD)
      throw Error("这张回单压缩后仍较大，请分开截图上传。");
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 110) + ".jpg";
    return new File([candidate], name, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } catch (e) {
    throw e instanceof Error ? e : Error("图片无法读取，请选择有效的回单。");
  } finally {
    URL.revokeObjectURL(url);
  }
}
