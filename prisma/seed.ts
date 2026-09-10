const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@walaaplus.com';
  const password = 'admin123';
  const passwordHash = await bcrypt.hash(password, 10);

  // Upsert Admin User
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: 'BUSINESS_OWNER' },
    create: {
      email,
      passwordHash,
      name: 'WalaaPlus Admin',
      role: 'BUSINESS_OWNER',
    }
  });

  // Ensure Agency exists
  let agency = await prisma.agency.findFirst({ where: { ownerId: user.id } });
  if (!agency) {
    agency = await prisma.agency.create({
      data: {
        name: 'WalaaPlus Main Agency',
        ownerId: user.id
      }
    });
  }

  // Ensure Business exists
  let business = await prisma.business.findFirst({ where: { ownerId: user.id } });
  if (!business) {
    business = await prisma.business.create({
      data: {
        name: 'Walaa Cafe',
        ownerId: user.id,
        agencyId: agency.id
      }
    });
  }

  console.log(`READY: ${email} | ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
