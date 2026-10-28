# Regiochecker: Node plus pdftotext (poppler) voor de weeklijsten van
# Súdwest-Fryslân, en tzdata zodat "maandag 07:00" Nederlandse tijd is.
FROM node:22-alpine

RUN apk add --no-cache poppler-utils tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY test ./test
COPY README.md ./

# Sommige gemeentesites sturen grote responsekoppen; zonder extra ruimte
# mislukt zo'n verzoek met een fetchfout die niets over de oorzaak zegt.
# node:sqlite (kamerstukken) is in Node 22 nog "experimenteel"; die waarschuwing
# bij elke start zegt niets.
ENV NODE_ENV=production \
    TZ=Europe/Amsterdam \
    PORT=3000 \
    REGIOCHECKER_DATA=/app/data \
    NODE_OPTIONS="--max-http-header-size=131072 --disable-warning=ExperimentalWarning"

USER node
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/gezond || exit 1

CMD ["node", "src/dienst.mjs"]
