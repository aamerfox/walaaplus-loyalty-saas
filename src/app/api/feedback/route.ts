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

  if (!businessId) return NextResponse.json({ stats: { avg: 0, googleCount: 0, internalCount: 0 } });

  const feedbacks = await prisma.feedback.findMany({
    where: { businessId },
    select: { rating: true }
  });

  const total = feedbacks.length;
  const avg = total > 0 ? (feedbacks.reduce((acc, curr) => acc + curr.rating, 0) / total).toFixed(1) : "0.0";
  const googleCount = feedbacks.filter(f => f.rating === 5).length;
  const internalCount = feedbacks.filter(f => f.rating < 5).length;

  return NextResponse.json({
    stats: {
      avg,
      googleCount,
      internalCount,
      total
    }
  });
}
