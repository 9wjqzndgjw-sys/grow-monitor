# Grow Monitor — Closed-Loop Grow Control

Grow Monitor is a telemetry and tuning system for indoor cultivation.

It connects your automation system (Hubitat, etc.) to a data pipeline and dashboard so you can:
- see what your tent is actually doing
- understand system behavior over time
- tune PID control using real data

## What it does

- Tracks temperature, humidity, and VPD
- Records actuator behavior (fan/dimmer)
- Visualizes trends over time
- Exports data for analysis
- Provides a PID tuning/replay tool

## Architecture

Hubitat → Webhook → Supabase → Dashboard → PID Tuner

## Why this exists

Most grows show you *values*.

This shows you *behavior*.

## Setup

(keep this minimal, link out if needed)

## More detail

See `PROJECT_SUMMARY.md` for full architecture and control design.