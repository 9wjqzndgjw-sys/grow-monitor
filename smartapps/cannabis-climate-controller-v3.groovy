definition(
    name: "Cannabis Climate Controller v3",
    namespace: "local",
    author: "You",
    description: "SEEDLING/VEG/FLOWER climate control with PID fan, heater, and dual humidifier automation",
    category: "Convenience",
    iconUrl: "",
    iconX2Url: ""
)

preferences {
    section("Devices") {
        input "humiditySensor",     "capability.relativeHumidityMeasurement", title: "Humidity Sensor",          required: true
        input "tempSensor",         "capability.temperatureMeasurement",      title: "Temperature Sensor",       required: true
        input "fanDimmer",          "capability.switchLevel",                 title: "Exhaust Fan Dimmer",       required: true
        input "lightsSwitch",       "capability.switch",                      title: "Lights ON Virtual Switch", required: true
        input "heater",             "capability.switch",                      title: "Heater (Switch)",          required: false
        input "constantHumidifier", "capability.switch",                      title: "Constant Humidifier",      required: false
        input "boostHumidifier",    "capability.switch",                      title: "Boost Humidifier",         required: false
    }
    section("Climate Targets") {
        input "growStage", "enum", title: "Growth Stage", options: ["SEEDLING", "VEG", "FLOWER"], defaultValue: "SEEDLING", required: true
    }
    section("PID Tuning (RH → Fan Speed)") {
        input "Kp",          "decimal", title: "Kp - Proportional gain",  defaultValue: 3.0,  required: true
        input "Ki",          "decimal", title: "Ki - Integral gain",      defaultValue: 0.05, required: true
        input "Kd",          "decimal", title: "Kd - Derivative gain",    defaultValue: 1.5,  required: true
        input "fanBase",     "number",  title: "Fan base speed % (idle)", defaultValue: 30,   required: true
        input "integralMax", "decimal", title: "Integral windup cap",     defaultValue: 15.0, required: true
    }
    section("Heater Tuning") {
        input "heaterOnDiff",  "decimal", title: "Heater ON when temp is this far below target (F)",  defaultValue: 1.5, required: true
        input "heaterOffDiff", "decimal", title: "Heater OFF when temp is this far above target (F)", defaultValue: 0.5, required: true
        input "heaterAllowLightsOn", "bool", title: "Allow heater during lights ON (for dim/cool lights)", defaultValue: true
    }
    section("Debug") {
        input "enableLogging", "bool", title: "Enable Debug Logging", defaultValue: false
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

def installed() { initialize() }
def updated()   { unschedule(); resetPID(); initialize() }

def initialize() {
    subscribe(humiditySensor, "humidity",    eventHandler)
    subscribe(tempSensor,     "temperature", eventHandler)
    subscribe(lightsSwitch,   "switch",      lightsHandler)
    runEvery1Minute(evaluateClimate)
    if (!atomicState.lastTime) resetPID()
}

def resetPID() {
    def     targets   = getTargets()
    boolean lightsOn  = lightsSwitch.currentValue("switch") == "on"
    Float   targetRH  = lightsOn ? targets.rhDay as Float : targets.rhNight as Float
    Float   curRH     = humiditySensor.currentValue("humidity") as Float
    Float   initError = (curRH != null) ? (curRH - targetRH) : 0.0
    atomicState.integral  = initError * 2.0
    atomicState.lastError = initError
    atomicState.lastDeriv = 0.0
    atomicState.lastTime  = now()
    logDebug("PID seeded — RH:${curRH} target:${targetRH} error:${initError} integral:${atomicState.integral}")
}

// ── Targets ────────────────────────────────────────────────────────────────

def getTargets() {
    if (growStage == "FLOWER") {
        return [tempDay: 78, tempNight: 70, rhDay: 50, rhNight: 55, tempTol: 2]
    } else if (growStage == "VEG") {
        return [tempDay: 78, tempNight: 71, rhDay: 55, rhNight: 60, tempTol: 2]
    } else { // SEEDLING
        // Seedlings need warm + humid + minimal airflow
        return [tempDay: 75, tempNight: 72, rhDay: 70, rhNight: 70, tempTol: 2]
    }
}

// ── Main evaluate loop ─────────────────────────────────────────────────────

def evaluateClimate() {
    Float curRH   = humiditySensor.currentValue("humidity")    as Float
    Float curTemp = tempSensor.currentValue("temperature")     as Float
    if (curRH == null || curTemp == null) { logDebug("Sensor data missing"); return }

    def     targets    = getTargets()
    boolean lightsOn   = lightsSwitch.currentValue("switch") == "on"
    Float   targetRH   = lightsOn ? targets.rhDay   as Float : targets.rhNight   as Float
    Float   targetTemp = lightsOn ? targets.tempDay as Float : targets.tempNight as Float

    // VPD calculation and tent-open detection
    Float   curVPD   = calcVPD(curTemp, curRH)
    Float   lastVPD  = (atomicState.lastVPD ?: curVPD) as Float
    Float   vpdDelta = Math.abs(curVPD - lastVPD) as Float
    atomicState.lastVPD = curVPD

    boolean tentOpen = vpdDelta > 0.15
    if (tentOpen) {
        log.info("Tent open detected — VPD delta ${String.format('%.3f',vpdDelta)} kPa — suppressing PID, resetting integral")
        atomicState.integral  = 0.0
        atomicState.lastError = 0.0
        atomicState.lastTime  = now()
        return
    }

    Integer fanSpeed = pidFanSpeed(curRH, targetRH, targets)

    manageHeater(curTemp, targetTemp, lightsOn)
    controlHumidifiers(curRH, targetRH, lightsOn)
    setFanSpeed(fanSpeed)

    logDebug("${growStage} | Lights:${lightsOn?'ON':'OFF'} | " +
             "Temp:${curTemp}F→${targetTemp}F | " +
             "RH:${curRH}%→${targetRH}% | " +
             "VPD:${String.format('%.3f',curVPD)}kPa Δ${String.format('%.3f',vpdDelta)} | " +
             "Fan:${fanSpeed}% | I:${String.format('%.2f', atomicState.integral as Double)}")
}

// ── VPD ───────────────────────────────────────────────────────────────────

def Float calcVPD(Float tempF, Float rh) {
    Float tempC = (tempF - 32) * 5 / 9
    Float svp   = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3))
    return ((1 - rh / 100) * svp).round(4) as Float
}

// ── PID Controller ─────────────────────────────────────────────────────────

def Integer pidFanSpeed(Float curRH, Float targetRH, Map targets) {
    long  now_ms  = now()
    long  lastMs  = (atomicState.lastTime  ?: now_ms) as long
    Float lastErr = (atomicState.lastError ?: 0.0)    as Float
    Float integ   = (atomicState.integral  ?: 0.0)    as Float

    Float dt = ((now_ms - lastMs) / 60000.0) as Float
    if (dt <= 0) dt = 1.0
    if (dt > 5)  dt = 5.0

    Float error = curRH - targetRH

    Float iMax = (integralMax ?: 15.0) as Float
    integ = Math.max(-iMax, Math.min(iMax, integ + (error * dt))) as Float

    Float rawDeriv    = (error - lastErr) / dt
    Float smoothDeriv = (0.3 * rawDeriv + 0.7 * ((atomicState.lastDeriv ?: 0.0) as Float)) as Float
    atomicState.lastDeriv = smoothDeriv

    Float output = ((Kp ?: 3.0) * error) +
                   ((Ki ?: 0.05) * integ) +
                   ((Kd ?: 1.5)  * smoothDeriv)

    Integer minFan = (growStage == "SEEDLING") ? 20 : 25
    Integer maxFan = (growStage == "SEEDLING") ? 50 : 100  // seedlings: cap fan to prevent drying

    Integer fanSpeed = Math.round(((fanBase ?: 30) as Float) + output) as Integer
    fanSpeed = Math.max(minFan, Math.min(maxFan, fanSpeed))

    atomicState.lastError = error
    atomicState.integral  = integ
    atomicState.lastTime  = now_ms

    return fanSpeed
}

// ── Fan output ─────────────────────────────────────────────────────────────

def setFanSpeed(Integer speed) {
    Integer cur = (fanDimmer.currentValue("level") ?: 0) as Integer
    if (Math.abs(speed - cur) >= 3) {
        fanDimmer.setLevel(speed)
        logDebug("Fan → ${speed}%  (was ${cur}%)")
    }
}

// ── Humidifier control ─────────────────────────────────────────────────────
//
//  Constant humidifier runs anytime we need humidity (lights on OR seedling stage).
//  Boost only fires when RH is well below target.
//
def controlHumidifiers(Float curRH, Float targetRH, boolean lightsOn) {
    // Seedlings need humidity 24/7. Other stages only during lights on.
    boolean wantConstant = lightsOn || (growStage == "SEEDLING")

    if (!wantConstant) {
        constantHumidifier?.off()
        boostHumidifier?.off()
        return
    }

    constantHumidifier?.on()

    if (boostHumidifier) {
        Float   diff  = curRH - targetRH
        boolean boost = boostHumidifier.currentValue("switch") == "on"
        if (!boost && diff <= -8) {
            boostHumidifier.on()
            logDebug("Boost ON — RH ${curRH}% is ${Math.abs(diff).round(1)}% below target")
        } else if (boost && diff >= -4) {
            boostHumidifier.off()
            logDebug("Boost OFF — RH recovered to ${curRH}%")
        }
    }
}

// ── Heater control ─────────────────────────────────────────────────────────
//
//  With a dim light, the heater needs to run even during lights-on to maintain target.
//  Hysteresis: ON when 1.5F below target, OFF when 0.5F above (configurable).
//  Optional toggle to disable heater during lights-on for hotter lights.
//
def manageHeater(Float curTemp, Float targetTemp, boolean lightsOn) {
    if (!heater) return

    // If lights are on AND user disabled heater-during-lights, turn off and exit
    if (lightsOn && !(heaterAllowLightsOn ?: true)) {
        if (heater.currentValue("switch") == "on") {
            heater.off()
            logDebug("Heater OFF — lights on, heater-during-lights disabled")
        }
        return
    }

    Float   diff      = curTemp - targetTemp
    boolean heaterOn  = heater.currentValue("switch") == "on"
    Float   onDiff    = (heaterOnDiff  ?: 1.5) as Float
    Float   offDiff   = (heaterOffDiff ?: 0.5) as Float

    if (!heaterOn && diff <= -onDiff) {
        heater.on()
        logDebug("Heater ON  — ${Math.abs(diff).round(1)}F below target (${targetTemp}F)")
    } else if (heaterOn && diff >= offDiff) {
        heater.off()
        logDebug("Heater OFF — ${diff.round(1)}F above target (${targetTemp}F)")
    }
}

// ── Event handlers ─────────────────────────────────────────────────────────

def eventHandler(evt)  { runIn(5, evaluateClimate) }
def lightsHandler(evt) { resetPID(); runIn(5, evaluateClimate) }

// ── Logging ────────────────────────────────────────────────────────────────

def logDebug(String msg) { if (enableLogging) log.debug(msg) }
