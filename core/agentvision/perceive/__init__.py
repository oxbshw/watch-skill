"""Perception: scene detection, perceptual-hash dedup, frame budgets, OCR.

Implemented in Milestone 1. Output contract is a ``PerceptionResult``:
ordered {timestamp, frame_path, scene_id, phash, ocr_text} plus metadata.
"""
