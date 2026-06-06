# occult — module contracts (build against these)

Vanilla ES modules, no build step, no framework. Browser-only (Web Bluetooth).
Foundation files already exist: `js/data/schema.js`, `js/data/db.js`,
`js/ble/uuids.js`, `js/util/events.js`, `js/util/format.js`.

## Object shapes
See `js/data/schema.js` header comments for **Profile** and **Reading**.
Key fact: a **Reading** stores raw scale fields (`weightKg`, `heartRate`,
`impedanceRaw`) PLUS a frozen derived snapshot (`bmi`, `bodyFatPct`, `fatMassKg`,
`ffmKg`, `tbwL`, `bodyWaterPct`, `bmrKcal`, `smmKg`, `smmPct`).

## js/ble/parser.js  (owner: BLE agent)
```
export function parseCultFrame(bytes /* Uint8Array|DataView, 11 bytes */)
  -> { phase:'weigh'|'body', weightKg, heartRate|null, impedanceRaw|null, checksumOk } | null
export function cultSelfTest() -> boolean   // asserts the captured frames below
```
Frame (11 bytes): `b[0]=0xCF` marker; `b[1]`=heart rate (body phase only);
`b[3..4]` LE uint16 = weight, ÷100 kg; `b[5..6]` LE uint16 = impedanceRaw;
`b[9]` phase flag (`0x01`=weigh, `0x00`=body/HR); `b[10]`=XOR of bytes 0..9.
Illustrative frames: `cf 00 00 4c 1d 00 00 00 00 01 9f`→75.0kg weigh;
`cf 3c c0 4c 1d f4 01 00 00 00 97`→75.0kg, byte1 60, bytes5-6 500, body.

## js/ble/client.js  (owner: BLE agent)
```
export class CultScaleClient {
  on(event, fn) -> dispose      // events below
  async requestAndConnect()     // navigator.bluetooth.requestDevice + subscribe 0xfff4
  disconnect()
}
```
Events: `state`('idle'|'connecting'|'connected'|'disconnected'),
`live`({weightKg, heartRate, phase}) on every frame, `stable`({weightKg,
heartRate, impedanceRaw}) once weight repeats ≥3 frames, `error`(err).
Use `js/ble/uuids.js` + `js/util/events.js`. requestDevice filters: namePrefix
from NAME_PREFIXES and services:[SCALE_SERVICE]; optionalServices:[SCALE_SERVICE].

## js/metrics/bodycomp.js  (owner: METRICS agent)
Pure functions, port of healthee tools/body_composition.py (cite same papers):
```
export function bmi(weightKg, heightCm)
export function bmiClass(bmi) -> string
export function bmrMifflin(weightKg, heightCm, age, sex)
export function bodyFatDeurenberg(bmi, age, sex)   // sex 'male'|'female'
export function tbwWatson(weightKg, heightCm, age, sex)
export function smmJanssen(heightCm, resistanceOhms, age, sex)
export function deriveReading({weightKg, impedanceRaw, age, sex, heightCm, impedanceScale})
  -> { bmi, bmiClass, bodyFatPct, fatMassKg, ffmKg, tbwL, bodyWaterPct, bmrKcal, smmKg, smmPct }
export function bodyCompSelfTest() -> boolean
```
Formulas: Mifflin-St Jeor 1990; Deurenberg 1991 BF%=1.20·BMI+0.23·age−10.8·(male?1:0)−5.4;
Watson 1980 TBW; Janssen 2000 SMM=(h²/R)·0.401+(male?3.825:0)−age·0.071+5.102 where
R = impedanceRaw × (impedanceScale || DEFAULT_IMPEDANCE_SCALE from schema.js).
If impedanceRaw is null, omit smm fields. Reference checks: BMI(100,200cm)=25.0;
bmrMifflin(80,180,30,'male')=1780; bodyFatDeurenberg(25,40,'male')=23.0.

## js/data/store.js  (owner: DATA agent)
CRUD over IndexedDB using openDb/req2promise/txDone from db.js:
```
export async function listProfiles(db)
export async function createProfile(db, {name,sex,birthYear,heightCm,color,impedanceScale})
export async function updateProfile(db, id, fields)
export async function deleteProfile(db, id)   // also delete that profile's readings
export async function getActiveProfileId(db)  // settings store key 'activeProfileId'
export async function setActiveProfileId(db, id)
export async function insertReading(db, reading)
export async function readingsForProfile(db, profileId)   // sorted oldest→newest
export async function latestReading(db, profileId)
export async function deleteReading(db, id)
```

## js/data/export.js  (owner: DATA agent)
```
export function readingsToCsv(readings) -> string
export async function exportAllJson(db) -> object   // {profiles, readings, settings}
export async function importAllJson(db, payload)
```

## js/dev/seed.js  (owner: DATA agent)
```
export async function seedDemoData(db)   // create 1-2 demo profiles + ~30 days of
// readings each (realistic weight drift + body-comp), source:'seed', only if empty
```
Use deriveReading from bodycomp.js so seeded rows carry the same derived fields.

## js/ui/charts.js, js/ui/render.js, js/ui/profiles-ui.js, index.html, styles.css, app.js
(owner: UI agent + integrator). See agent prompt. Match whoof's design language
(dark, premium cards) at C:\Users\anshu\healthee\whoof\web\{index.html,styles.css,app.js}.
charts.js uses global `Chart` from vendor/chart.umd.min.js (loaded via <script> in index.html).
