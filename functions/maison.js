/* Tout'zafer · page de catégorie https://toutzafer.re/maison (page : lib/ssr.js ; textes : categories.json) */
import { categoryResponse } from "../lib/ssr.js";
export const onRequestGet = context => categoryResponse(context, "maison");
