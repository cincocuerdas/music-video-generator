import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const host = (process.env.API_HOST || process.env.HOST || '127.0.0.1').trim();
  const port = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
  const apiBaseUrl = (
    process.env.API_BASE_URL ||
    `http://${host}:${port}/api/v1`
  ).replace(/\/+$/, '');
  console.log('🌱 Seeding database...');

  // Create a test project with real lyrics
  const project = await prisma.project.create({
    data: {
      userId: '00000000-0000-4000-8000-000000000001',
      title: 'Neon Dreams - Cyberpunk Anthem',
      status: 'DRAFT',
      lyrics: `Walking down the street at night
Neon lights are shining bright
I'm looking for a place to go
Where the music plays down low

Cyberpunk city, future dreams
Nothing is ever what it seems
Chrome and steel, rain and glow
In this world, we're just echoes

The skyline burns with electric fire
Higher and higher, we climb higher
Lost in the data stream tonight
Chasing shadows, chasing light

Memories fade like morning mist
In a world where nothing exists
But the beat goes on and on
Until the break of digital dawn`,
      visualStyle: 'cyberpunk',
      colorPalette: ['#00FFFF', '#FF00FF', '#0000FF', '#FF0000'],
      aspectRatio: '16:9',
    },
  });

  console.log('✅ Test project created:', project.id);
  console.log('');
  console.log('To start the pipeline, run:');
  console.log(`  curl -X POST ${apiBaseUrl}/jobs/pipeline/${project.id}/start`);
  console.log('');
  console.log('To check status:');
  console.log(`  curl ${apiBaseUrl}/jobs/pipeline/${project.id}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

