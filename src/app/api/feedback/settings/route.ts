import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

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
    select: { feedbackSettings: true }
  });

  return NextResponse.json({ settings: business?.feedbackSettings || {} });
}

export async function POST(req: Request) {
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

  if (!businessId) return NextResponse.json({ error: 'No business found' }, { status: 404 });

  const settings = await req.json();

  await prisma.business.update({
    where: { id: businessId },
    data: { feedbackSettings: settings }
  });

  return NextResponse.json({ success: true });
}
