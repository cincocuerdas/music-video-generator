import { Module } from '@nestjs/common';
import { PythonRunnerService } from './python-runner.service';

@Module({
  providers: [PythonRunnerService],
  exports: [PythonRunnerService], // <--- ¡ESTA ES LA CLAVE QUE FALTABA!
})
export class PythonRunnerModule {}