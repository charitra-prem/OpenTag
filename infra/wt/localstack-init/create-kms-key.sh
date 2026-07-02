#!/bin/bash
# Runs inside the localstack container when it's ready. Creates the fixed KMS
# key (arn:aws:kms:us-east-2:000000000000:key/00000000-0000-0000-0000-000000000001)
# that premapp-backend's encryption module requires — identical to the repo's
# infra/branch-deploy/create-kms-encryption-key.sh, fixed material so every
# recreation yields the same key.
FIXED_KEY_MATERIAL="U2FsdGVkX1+K8yfnrMn+QRyh2nWPfI9wXA84BGm6YAA="
awslocal kms create-key --region us-east-2 --tags '[{"TagKey":"_custom_id_","TagValue":"00000000-0000-0000-0000-000000000001"},{"TagKey":"_custom_key_material_","TagValue":"'"$FIXED_KEY_MATERIAL"'"}]'
