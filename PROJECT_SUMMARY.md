# 🌱 Grow Monitor — Home Grow Telemetry & PID Tuning System

## Overview

**Grow Monitor** is a lightweight observability and tuning platform for indoor cannabis cultivation.

It connects a real-time control system (e.g., Hubitat) with a persistent data layer (Supabase) and a visualization + analysis interface (React dashboard), enabling growers to:

* Monitor environmental conditions (Temperature, Humidity, VPD)
* Track actuator behavior (fan/dimmer, humidifiers, etc.)
* Analyze system dynamics over time
* Tune PID control loops using real historical data

This is not just a dashboard — it is a **closed-loop control observability system**.

---

## 🧠 System Architecture

```
Hubitat (Control Layer)
        ↓
Webhook (Vercel API)
        ↓
Supabase (Storage Layer)
        ↓
React Dashboard (Visualization)
        ↓
PID Tuner (Analysis + Simulation)
```

### Components

#### 1. Control Layer (External)

* Hubitat Groovy app
* Executes real-time climate control
* Sends telemetry via webhook

#### 2. API Layer (Vercel)

* Receives sensor/device events
* Validates payloads
* Inserts into database
* Hosts PID tuning endpoints

#### 3. Storage Layer (Supabase)

* PostgreSQL database
* Stores:

  * `sensor_readings`
  * `devices`
* Supports historical queries and downsampling

#### 4. Frontend (React + Vite)

* Grow dashboard (`/grow`)
* PID tuning interface (`/pid`)
* Time-range analysis and export

---

## 📊 Key Features

### Real-Time Monitoring

* Temperature (°F)
* Humidity (%)
* VPD (kPa)

### Historical Analysis

* Time ranges:

  * 6h / 12h / 24h / 7d / 30d
* Forward-filled data alignment
* Combined sensor + actuator view

### VPD Awareness

* Live VPD calculation
* Visual zone classification:

  * Low (risk of mold / poor transpiration)
  * Ideal (veg / flower)
  * High (plant stress)

### Device Tracking

* Fan/dimmer level tracking
* Correlation with environment changes

### CSV Export

* Export raw data for:

  * External analysis
  * Debugging
  * Model fitting

---

## ⚙️ PID Tuning System

The PID tuner is the most advanced part of the system.

### Capabilities

* Extracts ~48 hours of historical data
* Aligns:

  * Humidity (input)
  * Fan output (control signal)
* Fits a simplified system model
* Replays control behavior with different PID parameters

### Endpoints

* `/api/pid/fit-model`
* `/api/pid/replay`

### Purpose

Instead of guessing PID values, you can:

* See how your system actually responds
* Simulate changes safely
* Tune based on real plant/environment behavior

---

## 🧪 Control Philosophy

This system is designed around:

### Primary Control Variable

* **Relative Humidity (RH)**

### Derived Diagnostic

* **VPD (Vapor Pressure Deficit)**

### Actuators

* Fan (PID-controlled)
* Humidifiers (hysteresis)
* Heater (night-only logic)

### Strategy

| Component    | Method              |
| ------------ | ------------------- |
| Fan          | PID control         |
| Humidifier   | Hysteresis          |
| Heater       | Hysteresis          |
| Disturbances | VPD spike filter    |
| Stability    | Deadband + debounce |

---

## 🧰 Environment Variables

### Required (Frontend + API)

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

### Required (API only)

```bash
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

### Recommended (Server Compatibility)

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
```

> ⚠️ The PID endpoints currently depend on `VITE_SUPABASE_URL`.
> It is recommended to support both `SUPABASE_URL` and `VITE_SUPABASE_URL`.

---

## 🗄️ Database Schema (Simplified)

### `sensor_readings`

| Column    | Type      | Description                  |
| --------- | --------- | ---------------------------- |
| id        | UUID      | Primary key                  |
| device_id | TEXT      | Device identifier            |
| attribute | TEXT      | humidity / temperature / etc |
| value     | FLOAT     | Measured value               |
| timestamp | TIMESTAMP | Event time                   |

---

### `devices`

| Column | Type | Description         |
| ------ | ---- | ------------------- |
| id     | TEXT | Device identifier   |
| name   | TEXT | Human-readable name |

---

## ⚠️ Known Gotchas

### 1. Environment Variable Mismatch

* API uses `VITE_SUPABASE_URL`
* Vercel often uses `SUPABASE_URL`

**Fix:** support both

---

### 2. Service Role Key Missing

* PID endpoints require elevated access
* Without it → API failures

---

### 3. Hardcoded Device IDs

In `PidTuner.tsx`:

```ts
const HUMIDITY_DEVICE = 'YoLink Canopy'
const FAN_DEVICE = 'Dimmer'
```

If your DB uses different IDs → tuner fails silently or returns empty data.

---

### 4. Sensor Timing Mismatch

* Temperature and humidity may not update simultaneously
* System compensates via forward-fill

---

## 🔍 What This Enables (Practically)

Without this system:

* You see current values only
* You guess control behavior

With this system:

* You see system **dynamics over time**
* You identify:

  * oscillation
  * lag
  * overshoot
* You can tune like a real control system

---

## 🚀 Future Enhancements

### Short Term

* Dynamic device selection in PID tuner
* Better error handling for env variables
* Display PID internal values (error, integral, derivative)

### Medium Term

* Rate-of-change metrics (ΔRH/min, ΔTemp/min)
* Phase plots (fan vs RH)

### Advanced

* VPD-based control instead of RH-only
* Auto-tuning PID from historical data
* Anomaly detection (e.g., tent open events)

---

## 🧩 Philosophy

This project is built on a simple idea:

> Don’t just automate your grow — **understand it.**

It turns a grow tent into:

* a measurable system
* a controllable system
* a tunable system

---

## 👨‍🌾 Who This Is For

* Growers using automation (Hubitat, Home Assistant, etc.)
* People who want **control, not just monitoring**
* Anyone curious about:

  * PID control
  * environmental dynamics
  * plant-driven optimization

---

## 🏁 Summary

Grow Monitor is a:

> **Telemetry + Visualization + Control Tuning system for indoor cultivation**

It bridges the gap between:

* automation
* data
* and real understanding

And that’s where the real gains come from.

---
