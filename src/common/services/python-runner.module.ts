import { Module } from '@nestjs/common';
import { CircuitBreakerService } from './circuit-breaker.service';
import { PythonRunnerService } from './python-runner.service';

@Module({
  providers: [PythonRunnerService, CircuitBreakerService],
  exports: [PythonRunnerService, CircuitBreakerService],
})
export class PythonRunnerModule {}

