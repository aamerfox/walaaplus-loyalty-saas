import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: templateId } = await params;
    const body = await req.json();
    const { firstName, lastName, phone, email, dob } = body;

    if (!firstName || !phone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const template = await prisma.cardTemplate.findUnique({
      where: { id: templateId },
      include: { business: true }
    });

    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // 1. Create or Find Customer User
    // We use phone as the unique identifier for customers in Syria
    let customer = await prisma.user.findUnique({
      where: { phone }
    });

    if (!customer) {
      customer = await prisma.user.create({
        data: {
          name: `${firstName} ${lastName || ''}`.trim(),
          phone,
          email: email || null,
          role: 'CUSTOMER',
          birthday: dob ? new Date(dob) : null
        }
      });
    }

    // 2. Check if user already has this card
    const existingCard = await prisma.customerCard.findFirst({
      where: { customerId: customer.id, templateId }
    });

    if (existingCard) {
      return NextResponse.json({ success: true, cardId: existingCard.id, existing: true });
    }

    // 3. Issue New Card
    const card = await prisma.customerCard.create({
      data: {
        customerId: customer.id,
        templateId,
        status: 'ACTIVE',
        currentBalance: (template.rules as any)?.welcomePoints || 0
      }
    });

    // 4. Record Transaction
    await prisma.transaction.create({
      data: {
        cardId: card.id,
        amount: (template.rules as any)?.welcomePoints || 0,
        type: 'WELCOME_BONUS',
        description: 'Initial card issuance welcome bonus'
      }
    });

    return NextResponse.json({ success: true, cardId: card.id });
  } catch (error: any) {
    console.error('Enrollment Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
