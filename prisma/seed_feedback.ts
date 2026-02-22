import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Buscamos un proyecto existente para asociarle los votos
  const project = await prisma.project.findFirst();

  if (!project) {
    console.log("❌ Crea al menos un proyecto antes de correr esto.");
    return;
  }

  console.log(`💉 Inyectando conocimiento sintético al proyecto ${project.id}...`);

  const style = project.visualStyle || "cinematic"; // Usar el estilo del proyecto

  // 1. Inyectamos 40 LIKES (para subir la confianza > 50%)
  const positivePrompts = [
    "hyperrealistic 8k masterpiece, professional photography",
    "volumetric lighting, detailed texture, cinematic composition",
    "sharp focus, studio quality, dramatic lighting",
    "anamorphic lens, film grain, atmospheric depth",
    "masterpiece quality, stunning visuals, perfect anatomy",
    "cinematic color grading, professional lighting setup",
    "ultra detailed, photorealistic rendering, 8k resolution",
    "dramatic shadows, atmospheric fog, volumetric rays",
    "professional portrait, perfect skin texture, natural lighting",
    "epic composition, stunning backdrop, masterful framing"
  ];

  console.log(`🎨 Entrenando estilo: ${style}`);

  for (let i = 0; i < 40; i++) {
    await prisma.generationFeedback.create({
      data: {
        projectId: project.id,
        score: 1, // LIKE
        style: style,
        prompt: `${positivePrompts[i % positivePrompts.length]} - scene ${i + 1}`,
      }
    });
    process.stdout.write(`\r  👍 Likes: ${i + 1}/40`);
  }
  console.log(" ✓");

  // 2. Inyectamos 10 DISLIKES (para detectar patrones negativos)
  const negativePrompts = [
    "blurry amateur photo with bad hands",
    "distorted face with artifacts",
    "oversaturated colors, overexposed",
    "low quality, pixelated, noisy",
    "bad anatomy, mutated fingers"
  ];

  for (let i = 0; i < 10; i++) {
    await prisma.generationFeedback.create({
      data: {
        projectId: project.id,
        score: -1, // DISLIKE
        style: style,
        prompt: negativePrompts[i % negativePrompts.length],
      }
    });
    process.stdout.write(`\r  👎 Dislikes: ${i + 1}/10`);
  }
  console.log(" ✓");

  // Verificar resultados
  const stats = await prisma.generationFeedback.groupBy({
    by: ['score'],
    where: { style },
    _count: true,
  });

  const likes = stats.find(s => s.score === 1)?._count || 0;
  const dislikes = stats.find(s => s.score === -1)?._count || 0;
  const total = likes + dislikes;
  const confidence = Math.min(total / 50, 1);

  console.log("\n📊 Estadísticas finales:");
  console.log(`   Estilo: ${style}`);
  console.log(`   Likes: ${likes}`);
  console.log(`   Dislikes: ${dislikes}`);
  console.log(`   Success Rate: ${Math.round((likes / total) * 100)}%`);
  console.log(`   Confianza: ${Math.round(confidence * 100)}%`);
  console.log("\n✅ ¡Entrenamiento completado! La IA ahora debería aplicar optimizaciones.");
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
