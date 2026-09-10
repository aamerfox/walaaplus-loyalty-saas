import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ notifications: [] });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { ownedBusiness: true }
    });

    let businessId = user?.ownedBusiness?.id;
    if (!businessId && user) {
      const biz = await prisma.business.findFirst({ where: { ownerId: user.id } });
      businessId = biz?.id;
    }

    if (!businessId) return NextResponse.json({ notifications: [] });

    const notifications = await prisma.notification.findMany({
      where: { businessId, type: 'PUSH' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return NextResponse.json({ notifications });
  } catch {
    return NextResponse.json({ notifications: [] });
  }
}
