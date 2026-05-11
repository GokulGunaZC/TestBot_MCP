import { NextRequest, NextResponse } from 'next/server';

const incidents = [
  { id: 'inc-100', title: 'Payments Latency', severity: 'high', owner: 'Platform Response' },
  { id: 'inc-101', title: 'Search Index Delay', severity: 'medium', owner: 'Search Guild' }
];

export async function GET() {
  return NextResponse.json({ incidents });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (!body.title || !body.severity) {
    return NextResponse.json({ error: 'title and severity are required' }, { status: 400 });
  }
  return NextResponse.json({
    incident: { id: 'inc-102', title: body.title, severity: body.severity, owner: body.owner || 'Unassigned' }
  }, { status: 201 });
}
