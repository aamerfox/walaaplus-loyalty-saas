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

    const businessId = user?.ownedBusiness?.id;
    if (!businessId) {
      return NextResponse.json({ locations: [] });
    }

    const locations = await prisma.location.findMany({
      where: { businessId },
      orderBy: { name: 'asc' }
    });

    return NextResponse.json({ locations });
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

    const businessId = user?.ownedBusiness?.id;
    if (!businessId) {
      return NextResponse.json({ error: 'No business found' }, { status: 403 });
    }

    const body = await req.json();
    const { name, address, lat, lng, radius, message } = body;

    if (!name || !lat || !lng) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const location = await prisma.location.create({
      data: {
        name,
        address: address || '',
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        radius: parseInt(radius) || 100,
        lockscreenMessage: message || null,
        businessId
      }
    });

    // Update business branding/settings if message is provided
    // In a real pass generator, this message would be stored in metadata.
    // For now we persist the location.

    return NextResponse.json({ success: true, location });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
