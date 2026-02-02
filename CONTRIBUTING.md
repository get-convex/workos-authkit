# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm run clean
npm run build
npm run typecheck
npm run test
npm run lint
```

## Deploying

### Building a one-off package

```sh
npm run clean
npm run build
npm pack
```

### Deploying a new version

```sh
npm run release
```

#### Alpha release

```sh
npm run alpha
```
