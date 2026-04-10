/*
  API client — thin wrapper around the Express backend.

  All fetch calls go through here. To swap data source (e.g. direct Databricks),
  only this file needs to change — no component touches fetch directly.
*/

const BASE = "http://localhost:3001/api";

export const fetchP8 = () => fetch(`${BASE}/p8`).then(r => r.json());
export const fetchP9 = () => fetch(`${BASE}/p9`).then(r => r.json());
export const fetchGraph = () => fetch(`${BASE}/p9/graph`).then(r => r.json());
export const fetchP10 = () => fetch(`${BASE}/p10`).then(r => r.json());
export const fetchP11 = () => fetch(`${BASE}/p11`).then(r => r.json());
export const fetchP12 = () => fetch(`${BASE}/p12`).then(r => r.json());
