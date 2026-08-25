import path from 'node:path';

// r2 리뷰 F2: jobId로 경로를 조립하는 모든 곳(업로드 이미지 서빙, JobStore의
// state.json 위치)이 반드시 거쳐야 하는 단일 검증 지점. 두 곳에 같은 검사를
// 복붙하면 다음에 셋째 호출자가 늘어날 때 조용히 다시 뚫린다.
//
// 접두사는 dataDir이 아니라 <dataDir>/jobs/로 좁힌다 — jobId='..'는 dataDir
// 안쪽이지만 <dataDir>/jobs/ 바깥이라, dataDir까지만 검사하면 이 경우를
// 놓친다(r1 수정 이후에도 남아 있던 틈).
export function assertSafeJobDir(dataDir: string, jobId: string): string {
  const jobsRoot = path.resolve(dataDir, 'jobs');
  const jobsRootPrefix = jobsRoot.endsWith(path.sep) ? jobsRoot : jobsRoot + path.sep;
  const jobDir = path.resolve(jobsRoot, jobId);
  if (!jobDir.startsWith(jobsRootPrefix)) {
    throw new Error(`assertSafeJobDir: jobId '${jobId}' escapes the jobs directory`);
  }
  return jobDir;
}
