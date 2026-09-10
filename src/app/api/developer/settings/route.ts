import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { randomBytes } from 'crypto';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    include: { ownedBusiness: true }
  });

  let businessId = user?.ownedBusiness?.id;
  if (!businessId && user) {
    const biz = await prisma.business.findFirst({ where: { ownerId: user.id } });
    businessId = biz?.id;
  }

  if (!businessId) return NextResponse.json({ settings: {} });

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { apiToken: true, webhookSettings: true }
  });

  return NextResponse.json({
    apiToken: business?.apiToken,
    webhookSettings: business?.webhookSettings || {
      cardIssued: { url: "", active: false },
      cardScanned: { url: "", active: false },
      feedbackReceived: { url: "", active: false },
    }
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { action, webhookSettings } = await req.json();

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    include: { ownedBusiness: true }
  });

  let businessId = user?.ownedBusiness?.id;
  if (!businessId && user) {
    const biz = await prisma.business.findFirst({ where: { ownerId: user.id } });
    businessId = biz?.id;
  }

  if (!businessId) return NextResponse.json({ error: 'No business found' }, { status: 404 });

  if (action === 'generate_key') {
    const newKey = `wp_live_${randomBytes(20).toString('hex')}`;
    await prisma.business.update({
      where: { id: businessId },
      data: { apiToken: newKey }
    });
    return NextResponse.json({ apiToken: newKey });
  }

  if (webhookSettings) {
    await prisma.business.update({
      where: { id: businessId },
      data: { webhookSettings }
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
