/* Tout'zafer · page de catégorie https://toutzafer.re/bebe-enfants (page : lib/ssr.js ; textes : categories.json) */
import { categoryResponse } from "../lib/ssr.js";
export const onRequestGet = ({ request, env }) => categoryResponse(request, env, "enfants");
