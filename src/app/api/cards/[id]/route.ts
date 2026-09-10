import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const card = await prisma.cardTemplate.findUnique({
      where: { id }
    });

    if (!card) {
      return NextResponse.json({ error: 'Card not found' }, { status: 404 });
    }

    return NextResponse.json({ card });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();

    const card = await prisma.cardTemplate.update({
      where: { id },
      data: {
        name: body.name,
        type: body.type,
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
        }
      }
    });

    return NextResponse.json({ success: true, card });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
