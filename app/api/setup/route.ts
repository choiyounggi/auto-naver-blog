import { NextResponse } from 'next/server';
import { readSetupState } from '@/lib/aside/blog-meta';
import { ENV_FILE_PATH, loadConfig } from '@/lib/config';

// 온보딩 화면이 폴링하는 상태. process.env 가 아니라 .env 파일을 읽으므로, 서버를 띄운 뒤
// 로그인해도 재시작 없이 반영된다.
export async function GET(): Promise<Response> {
  const config = loadConfig();
  const state = await readSetupState({
    envPath: ENV_FILE_PATH,
    cookieFile: config.cookieFile,
    envOverrides: { blogId: config.naverBlogId },
  });
  return NextResponse.json(state);
}
