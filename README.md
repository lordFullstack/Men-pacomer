# Men-pacomer
Menú digital pa' comer: el cliente arma sus platos y envía el pedido por WhatsApp.
Datos en Supabase (`public.productos`, `public.negocio`, bucket `productos-img`).

## Estructura

| Archivo | Qué es |
|---|---|
| `src/app.jsx` | Código fuente de la app (React). **Edita aquí.** |
| `src/index.template.html` | `<head>`: título, vista previa para WhatsApp (Open Graph), estilos globales |
| `index.html` | **Generado** por `npm run build`. Es lo que publica GitHub Pages. No lo edites a mano. |
| `supabase/seguridad.sql` | Políticas RLS, tabla de admins y columnas nuevas |

## Desarrollo

```bash
npm install
npm run serve      # http://localhost:8080, recompila al guardar
npm run build      # genera index.html: córrelo antes de cada commit
```

## Admin

Entra con `#admin` al final de la URL (o tocando 3 veces el pie de página).
El acceso usa Supabase Auth (correo y contraseña):

1. Supabase → Authentication → Users → **Add user** (correo + contraseña).
2. Cambia el correo en `supabase/seguridad.sql` y ejecútalo en el SQL Editor.
3. Recomendado: desactiva "Allow new users to sign up" en Authentication.

Solo los usuarios en `public.admins` pueden modificar productos, negocio e imágenes.
