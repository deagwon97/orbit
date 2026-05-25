export const config = {
  port: Number(process.env.PORT ?? 3001),
  orbitd: process.env.ORBITD_URL ?? "http://127.0.0.1:7777",
  token: process.env.ORBIT_TOKEN ?? ""
};
