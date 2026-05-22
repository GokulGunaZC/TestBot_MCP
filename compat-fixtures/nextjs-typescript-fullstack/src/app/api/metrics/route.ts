import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    metrics: {
      openIncidents: 2,
      responseSla: '94 percent',
      customerHealth: 'stable'
    }
  });
}
