import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { ownedBusiness: true }
    });

    const businessId = user?.ownedBusiness?.id;
    if (!businessId) {
      return NextResponse.json({ error: 'No business found' }, { status: 403 });
    }

    // Ensure location belongs to this business
    const location = await prisma.location.findUnique({
      where: { id }
    });

    if (!location || location.businessId !== businessId) {
      return NextResponse.json({ error: 'Location not found or access denied' }, { status: 404 });
    }

    await prisma.location.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
