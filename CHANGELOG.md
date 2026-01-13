# Changelog

## 0.1.6
- fix: error when handler for events tried getting a handler that didn't exist, now it checks to see if there is a handler for the event before returning it
- fix: circular dependency with internal.auth where you needed to build before using it
- chore: update dependencies

## 0.1.5
- fix: add context field to webhook request

## 0.1.4

- fix: upgrade @workos-inc/node for crypto error fix

## 0.1.3

fix: remove assertion of WEBHOOK_ACTION_SECRET

## 0.1.2

- fix: temporarily pin @workos-inc/node to avoid crypto import
- fix: make options object not required

## 0.1.1

- Initial release.
