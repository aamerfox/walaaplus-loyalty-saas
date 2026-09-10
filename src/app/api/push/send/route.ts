import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { title, message, segment = 'All' } = await req.json();

    if (!title || !message) {
      return NextResponse.json({ error: 'Title and message are required' }, { status: 400 });
    }

    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (!appId || !apiKey) {
      return NextResponse.json({
        error: 'OneSignal credentials not configured. Add ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY to your .env.local file.'
      }, { status: 503 });
    }

    // Call OneSignal REST API
    const oneSignalRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${apiKey}`,
      },
      body: JSON.stringify({
        app_id: appId,
        included_segments: [segment],
        headings: { en: title, ar: title },
        contents: { en: message, ar: message },
      }),
    });

    const result = await oneSignalRes.json();

    if (!oneSignalRes.ok) {
      return NextResponse.json({ error: result.errors?.[0] || 'OneSignal API error' }, { status: 500 });
    }

    // Persist to DB for broadcast history
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { ownedBusiness: true }
    });

    if (user?.ownedBusiness) {
      await prisma.notification.create({
        data: {
          title,
          message,
          type: 'PUSH',
          businessId: user.ownedBusiness.id,
          status: 'SENT',
          externalId: result.id,
          recipientCount: result.recipients ?? 0,
        }
      });
    }

    return NextResponse.json({
      success: true,
      notificationId: result.id,
      recipients: result.recipients ?? 0,
    });
  } catch (error: any) {
    console.error('Push send error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
