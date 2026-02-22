#!/usr/bin/env python3
"""
Live Steering Module - Just-in-Time Direction System

Este modulo permite al director (usuario) enviar señales en tiempo real
durante la generacion de imagenes para ajustar el rumbo creativo.

Señales soportadas:
- BOOST (Like): Refuerza el estilo actual, mantiene la direccion
- CORRECT (Dislike): Aplica variacion, cambia el rumbo

El sistema usa Redis para comunicacion rapida, con fallback a archivos JSON.
"""

import json
import os
import sys
import time
from typing import Optional, Dict, Any, Literal
from dataclasses import dataclass
from enum import Enum
from dotenv import load_dotenv
from redis_utils import get_redis_client as create_redis_client

# Load .env
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
load_dotenv(os.path.join(root_dir, '.env'))


class SignalType(Enum):
    """Tipos de señales de steering"""
    BOOST = "boost"       # Usuario le gusta, reforzar estilo
    CORRECT = "correct"   # Usuario no le gusta, cambiar direccion


@dataclass
class SteeringSignal:
    """Estructura de una señal de steering"""
    type: SignalType
    scene_index: int
    timestamp: int
    processed: bool = False
    intensity: float = 1.0  # 0.5 = suave, 1.0 = normal, 1.5 = fuerte
    reason: Optional[str] = None  # Razon opcional del usuario

    def to_dict(self) -> dict:
        return {
            "type": self.type.value,
            "sceneIndex": self.scene_index,
            "timestamp": self.timestamp,
            "processed": self.processed,
            "intensity": self.intensity,
            "reason": self.reason
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'SteeringSignal':
        return cls(
            type=SignalType(data.get("type", "boost")),
            scene_index=data.get("sceneIndex", 0),
            timestamp=data.get("timestamp", int(time.time() * 1000)),
            processed=data.get("processed", False),
            intensity=data.get("intensity", 1.0),
            reason=data.get("reason")
        )


@dataclass
class PromptModification:
    """Modificaciones a aplicar al prompt basadas en la señal"""
    prompt_suffix: str = ""           # Texto a agregar al prompt positivo
    negative_suffix: str = ""          # Texto a agregar al negative prompt
    cfg_multiplier: float = 1.0        # Multiplicador de CFG (1.0 = sin cambio)
    seed_variation: int = 0            # Variacion a agregar al seed
    denoise_boost: float = 0.0         # Boost de denoising (para mas variacion)
    message: str = ""                  # Mensaje para logs/UI


class LiveSteeringManager:
    """
    Gestor de señales de steering en tiempo real.

    Lee señales de Redis o archivos JSON y genera modificaciones
    inteligentes para los prompts de generacion.
    """

    # Patrones de modificacion predefinidos
    BOOST_PATTERNS = {
        "quality": "(masterpiece:1.2), (best quality:1.2), highly detailed",
        "consistency": "(consistent style:1.3), (coherent composition:1.2)",
        "cinematic": "(cinematic lighting:1.2), (film grain:1.1), atmospheric",
        "emotional": "(emotional depth:1.2), (expressive:1.1), powerful",
    }

    CORRECT_PATTERNS = {
        "variation": "(visual variation:1.3), (different angle:1.2), fresh perspective",
        "style_shift": "(alternative interpretation:1.2), reimagined",
        "composition": "(dynamic composition:1.3), (new framing:1.2)",
        "mood": "(mood shift:1.2), (tonal variation:1.1)",
    }

    NEGATIVE_BOOST = {
        "quality": "amateur, low quality, blurry, artifacts",
        "consistency": "inconsistent, disjointed, chaotic",
        "safety": "bad composition, awkward pose, distorted anatomy",
    }

    def __init__(self, project_id: str):
        self.project_id = project_id
        self.redis_client = self._get_redis_client()
        self.signals_dir = os.path.join(root_dir, 'output', 'live-signals')
        self.signal_history: list[SteeringSignal] = []
        self.last_signal: Optional[SteeringSignal] = None

        # Ensure signals directory exists
        os.makedirs(self.signals_dir, exist_ok=True)

    def _get_redis_client(self):
        """Obtiene cliente Redis si esta disponible"""
        return create_redis_client(log_prefix="LiveSteering")

    def _get_signal_file_path(self) -> str:
        """Ruta del archivo de señal para este proyecto"""
        return os.path.join(self.signals_dir, f"{self.project_id}.json")

    def check_for_signal(self) -> Optional[SteeringSignal]:
        """
        Verifica si hay una señal pendiente para procesar.

        Primero intenta Redis (mas rapido), luego archivo JSON (fallback).
        Solo retorna señales no procesadas.
        """
        signal_data = None

        # 1. Intentar Redis primero (mas rapido)
        if self.redis_client:
            try:
                redis_key = f"steering:{self.project_id}"
                data = self.redis_client.get(redis_key)
                if data:
                    signal_data = json.loads(data)
            except Exception as e:
                print(f"  [Steering] Error leyendo Redis: {e}", file=sys.stderr)

        # 2. Fallback a archivo JSON
        if not signal_data:
            file_path = self._get_signal_file_path()
            if os.path.exists(file_path):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        signal_data = json.load(f)
                except Exception as e:
                    print(f"  [Steering] Error leyendo archivo: {e}", file=sys.stderr)

        # 3. Procesar señal si existe y no esta procesada
        if signal_data and not signal_data.get("processed", False):
            signal = SteeringSignal.from_dict(signal_data)
            self.last_signal = signal
            return signal

        return None

    def mark_signal_processed(self, signal: SteeringSignal):
        """Marca una señal como procesada en ambos storages"""
        signal.processed = True
        signal_data = signal.to_dict()

        # Actualizar Redis
        if self.redis_client:
            try:
                redis_key = f"steering:{self.project_id}"
                self.redis_client.set(redis_key, json.dumps(signal_data))
            except Exception:
                pass

        # Actualizar archivo
        file_path = self._get_signal_file_path()
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(signal_data, f, indent=2)
        except Exception:
            pass

        # Agregar al historial
        self.signal_history.append(signal)

    def get_prompt_modification(
        self,
        signal: SteeringSignal,
        current_scene_index: int,
        verse_type: str = "NARRATIVE"
    ) -> PromptModification:
        """
        Genera las modificaciones de prompt basadas en la señal.

        La logica varía segun:
        - Tipo de señal (boost vs correct)
        - Intensidad de la señal
        - Tipo de verso actual
        - Distancia desde la escena donde se envio la señal
        """
        mod = PromptModification()
        intensity = signal.intensity

        # Calcular "decay" - señales viejas tienen menos efecto
        scenes_since_signal = current_scene_index - signal.scene_index
        decay_factor = max(0.3, 1.0 - (scenes_since_signal * 0.15))
        effective_intensity = intensity * decay_factor

        if signal.type == SignalType.BOOST:
            # ═══════════════════════════════════════════════════════════════
            # BOOST: Usuario le gusto - reforzar y mantener direccion
            # ═══════════════════════════════════════════════════════════════

            # Seleccionar patrones segun tipo de verso
            if verse_type in ["INTROSPECTIVE", "EMOTIONAL"]:
                pattern = self.BOOST_PATTERNS["emotional"]
            elif verse_type in ["NARRATIVE", "LITERAL"]:
                pattern = self.BOOST_PATTERNS["cinematic"]
            else:
                pattern = self.BOOST_PATTERNS["quality"]

            # Agregar consistencia para mantener estilo
            pattern += f", {self.BOOST_PATTERNS['consistency']}"

            # Aplicar con intensidad
            if effective_intensity > 1.2:
                mod.prompt_suffix = f"({pattern}:1.3)"
            elif effective_intensity > 0.8:
                mod.prompt_suffix = f"({pattern}:1.1)"
            else:
                mod.prompt_suffix = pattern

            # CFG ligeramente mas alto para mas adherencia al prompt
            mod.cfg_multiplier = 1.0 + (0.1 * effective_intensity)

            # Seed estable para consistencia
            mod.seed_variation = 0

            mod.negative_suffix = self.NEGATIVE_BOOST["quality"]
            mod.message = f"BOOST aplicado (intensidad: {effective_intensity:.1f}, decay: {decay_factor:.1f})"

        elif signal.type == SignalType.CORRECT:
            # ═══════════════════════════════════════════════════════════════
            # CORRECT: Usuario no le gusto - introducir variacion
            # ═══════════════════════════════════════════════════════════════

            # Seleccionar tipo de correccion segun verso
            if verse_type in ["RHYTHMIC", "TRANSITION"]:
                pattern = self.CORRECT_PATTERNS["composition"]
            elif verse_type in ["INTROSPECTIVE"]:
                pattern = self.CORRECT_PATTERNS["mood"]
            else:
                pattern = self.CORRECT_PATTERNS["variation"]

            # Aplicar con intensidad
            if effective_intensity > 1.2:
                mod.prompt_suffix = f"({pattern}:1.4)"
                mod.seed_variation = 777  # Cambio significativo
            elif effective_intensity > 0.8:
                mod.prompt_suffix = f"({pattern}:1.2)"
                mod.seed_variation = 333  # Cambio moderado
            else:
                mod.prompt_suffix = pattern
                mod.seed_variation = 111  # Cambio suave

            # CFG ligeramente mas bajo para mas variacion
            mod.cfg_multiplier = 1.0 - (0.15 * effective_intensity)

            # Mas denoising para mas cambios
            mod.denoise_boost = 0.1 * effective_intensity

            mod.negative_suffix = f"{self.NEGATIVE_BOOST['safety']}, (repetitive:1.2)"
            mod.message = f"CORRECT aplicado (intensidad: {effective_intensity:.1f}, seed +{mod.seed_variation})"

        return mod

    def apply_modification(
        self,
        original_prompt: str,
        original_negative: str,
        original_cfg: float,
        original_seed: int,
        modification: PromptModification
    ) -> Dict[str, Any]:
        """
        Aplica las modificaciones al prompt y parametros.

        Retorna un diccionario con los valores modificados.
        """
        # Construir prompt modificado
        if modification.prompt_suffix:
            modified_prompt = f"{original_prompt}, {modification.prompt_suffix}"
        else:
            modified_prompt = original_prompt

        # Construir negative modificado
        if modification.negative_suffix:
            modified_negative = f"{original_negative}, {modification.negative_suffix}"
        else:
            modified_negative = original_negative

        # Aplicar multiplicadores
        modified_cfg = original_cfg * modification.cfg_multiplier
        modified_seed = original_seed + modification.seed_variation

        return {
            "prompt": modified_prompt,
            "negative_prompt": modified_negative,
            "cfg": round(modified_cfg, 2),
            "seed": modified_seed,
            "denoise_boost": modification.denoise_boost,
            "was_modified": bool(modification.prompt_suffix or modification.seed_variation),
            "message": modification.message
        }

    def emit_signal_processed(self, signal: SteeringSignal, modification: PromptModification):
        """Emite evento de señal procesada via Redis para feedback al frontend"""
        if not self.redis_client:
            return

        try:
            event = {
                "projectId": self.project_id,
                "type": "steering_applied",
                "data": {
                    "signalType": signal.type.value,
                    "sceneIndex": signal.scene_index,
                    "message": modification.message,
                    "timestamp": int(time.time() * 1000)
                }
            }
            self.redis_client.publish("job_events", json.dumps(event))
        except Exception as e:
            print(f"  [Steering] Error emitiendo evento: {e}", file=sys.stderr)

    def get_stats(self) -> dict:
        """Retorna estadisticas de steering para este proyecto"""
        boost_count = sum(1 for s in self.signal_history if s.type == SignalType.BOOST)
        correct_count = sum(1 for s in self.signal_history if s.type == SignalType.CORRECT)

        return {
            "total_signals": len(self.signal_history),
            "boost_count": boost_count,
            "correct_count": correct_count,
            "last_signal": self.last_signal.to_dict() if self.last_signal else None
        }


def check_and_apply_steering(
    project_id: str,
    scene_index: int,
    prompt: str,
    negative_prompt: str,
    cfg: float,
    seed: int,
    verse_type: str = "NARRATIVE"
) -> Dict[str, Any]:
    """
    Funcion de conveniencia para usar en generate_images.py

    Verifica si hay señales pendientes y aplica modificaciones.

    Returns:
        Dict con prompt, negative_prompt, cfg, seed (posiblemente modificados)
        y flag 'was_modified' + 'message'
    """
    manager = LiveSteeringManager(project_id)

    signal = manager.check_for_signal()

    if signal:
        print(f"  [Steering] Señal detectada: {signal.type.value} en escena {signal.scene_index}", file=sys.stderr)

        modification = manager.get_prompt_modification(signal, scene_index, verse_type)
        result = manager.apply_modification(prompt, negative_prompt, cfg, seed, modification)

        # Marcar como procesada
        manager.mark_signal_processed(signal)

        # Emitir evento de feedback
        manager.emit_signal_processed(signal, modification)

        print(f"  [Steering] {result['message']}", file=sys.stderr)
        return result

    # Sin señal - retornar valores originales
    return {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "cfg": cfg,
        "seed": seed,
        "denoise_boost": 0.0,
        "was_modified": False,
        "message": ""
    }


# CLI test
if __name__ == "__main__":
    print("=== Live Steering Module Test ===")

    # Test con proyecto de prueba
    test_project = "test-project-123"
    manager = LiveSteeringManager(test_project)

    # Simular una señal
    test_signal = SteeringSignal(
        type=SignalType.CORRECT,
        scene_index=2,
        timestamp=int(time.time() * 1000),
        intensity=1.2,
        reason="Quiero algo diferente"
    )

    # Guardar señal de prueba
    file_path = manager._get_signal_file_path()
    with open(file_path, 'w') as f:
        json.dump(test_signal.to_dict(), f, indent=2)

    print(f"Señal de prueba guardada en: {file_path}")

    # Probar lectura y aplicacion
    result = check_and_apply_steering(
        project_id=test_project,
        scene_index=3,
        prompt="A person walking in the rain",
        negative_prompt="blurry, bad quality",
        cfg=7.0,
        seed=12345,
        verse_type="INTROSPECTIVE"
    )

    print(f"\nResultado:")
    print(f"  Prompt: {result['prompt'][:80]}...")
    print(f"  CFG: {result['cfg']}")
    print(f"  Seed: {result['seed']}")
    print(f"  Modified: {result['was_modified']}")
    print(f"  Message: {result['message']}")
