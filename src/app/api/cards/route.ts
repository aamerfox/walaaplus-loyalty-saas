import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { ownedBusiness: true }
    });

    if (!user) {
      return NextResponse.json({ cards: [] });
    }

    // Fallback: find business by ownerId directly if relation isn't loaded
    let businessId = user.ownedBusiness?.id;
    if (!businessId) {
      const business = await prisma.business.findFirst({
        where: { ownerId: user.id }
      });
      businessId = business?.id;
    }

    if (!businessId) {
      return NextResponse.json({ cards: [] });
    }

    const cards = await prisma.cardTemplate.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' }
    });

    return NextResponse.json({ cards });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { ownedBusiness: true }
    });

    if (!user || !user.ownedBusiness) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const body = await req.json();

    const card = await prisma.cardTemplate.create({
      data: {
        name: body.name || `${body.type} Card`,
        type: body.type,
        description: body.description || '',
        design: {
          primaryColor: body.primaryColor,
          bgColor: body.bgColor,
          hidePoweredBy: body.hidePoweredBy,
          requireCustomerImage: body.requireCustomerImage
        },
        rules: {
          stampsCount: body.stampsCount,
          cashbackPercent: body.cashbackPercent,
          discountPercent: body.discountPercent,
          subscriptionItem: body.subscriptionItem
        },
        businessId: user.ownedBusiness.id
      }
    });

    return NextResponse.json({ success: true, card });
  } catch (error: any) {
    console.error('Card Creation Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
