import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { phone, action } = await req.json();
  if (!phone) return NextResponse.json({ error: 'Phone number required' }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    include: { ownedBusiness: true }
  });

  const businessId = user?.ownedBusiness?.id;
  if (!businessId) return NextResponse.json({ error: 'Only business owners can award stamps' }, { status: 403 });

  let customer = await prisma.user.findFirst({
    where: { phone, role: 'CUSTOMER' },
    include: {
      customerCards: {
        where: { template: { businessId } }
      }
    }
  });

  // AUTO-ENROLLMENT: If customer doesn't exist or has no card for this business
  if (!customer) {
    customer = await prisma.user.create({
      data: {
        name: `Customer ${phone.slice(-4)}`,
        phone,
        role: 'CUSTOMER',
      },
      include: { customerCards: true }
    });
  }

  let card = customer.customerCards[0];
  if (!card) {
    // Find the first active template for this business
    const template = await prisma.cardTemplate.findFirst({
      where: { businessId, isActive: true }
    });
    
    if (!template) return NextResponse.json({ error: 'No active card templates for this business' }, { status: 404 });

    card = await prisma.customerCard.create({
      data: {
        customerId: customer.id,
        templateId: template.id,
        status: 'ACTIVE',
        currentBalance: 0
      }
    });
  }

  if (action === 'award_stamp') {
    const updatedCard = await prisma.customerCard.update({
      where: { id: card.id },
      data: { 
        currentBalance: card.currentBalance + 1,
        lastVisitAt: new Date(),
        transactions: {
          create: {
            type: 'STAMP_AWARD',
            amount: 1
          }
        }
      }
    });

    return NextResponse.json({ 
      success: true, 
      newBalance: updatedCard.currentBalance,
      customerName: customer.name
    });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
