import { NextRequest, NextResponse } from "next/server";
import { uploadImageToTos } from "@/lib/tos";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });
    }
    const url = await uploadImageToTos(file);
    return NextResponse.json({ ok: true, url });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
