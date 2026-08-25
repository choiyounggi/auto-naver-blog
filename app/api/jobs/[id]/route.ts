import { NextResponse } from 'next/server';
import { getJobStore } from '@/lib/job/store-instance';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const store = getJobStore();

  let job;
  try {
    job = await store.get(id);
  } catch (err) {
    console.error(`GET /api/jobs/${id}: failed to read job state`, err);
    return NextResponse.json({ error: 'failed to read job state' }, { status: 500 });
  }

  if (!job) {
    return NextResponse.json({ error: `job '${id}' not found` }, { status: 404 });
  }

  return NextResponse.json(job);
}
