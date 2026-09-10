import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { cardId, action } = await req.json();
  if (!cardId) return NextResponse.json({ error: 'Card ID required' }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    include: { ownedBusiness: true }
  });

  const businessId = user?.ownedBusiness?.id;
  if (!businessId) return NextResponse.json({ error: 'Only business owners can scan' }, { status: 403 });

  // Find the card and ensure it belongs to this business
  const card = await prisma.customerCard.findUnique({
    where: { id: cardId },
    include: { template: true }
  });

  if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  if (card.template.businessId !== businessId) return NextResponse.json({ error: 'Card belongs to another business' }, { status: 403 });

  if (action === 'award_stamp') {
    const newBalance = card.currentBalance + 1;
    let status = 'ACTIVE';
    
    // Check if reward achieved
    if (newBalance >= card.template.stampsCount) {
      // Logic for reward can go here (e.g. create a coupon or just reset stamps)
      // For now, we'll just keep it at max or allow overflow
    }

    const updatedCard = await prisma.customerCard.update({
      where: { id: cardId },
      data: { 
        currentBalance: newBalance,
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
      customerName: card.customerId // We could join User here
    });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
