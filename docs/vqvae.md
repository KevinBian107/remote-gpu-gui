# VQVAE Training Quick Reference

Training lives in `vqvae_jax/` on the `kevin/vqvae-rvq` branch of `talmolab/track-mjx`.

All commands assume you're in the `vqvae_jax/` directory:

```bash
cd vqvae_jax
```

Config is Hydra-based. Default config: `configs/vqvae_minimal.yaml`. Override any param with dot notation on the command line.

---

## Common Config Changes

### stickiness_bias

Temporal persistence bias per RVQ depth. Higher = codes stick across timesteps.
Default: `[1.0, 0.0]` (depth-0 gets bias, depth-1 gets none).

```bash
python train_vqvae.py network_config.stickiness_bias=[2.0,0.0]
```

### num_codes

Codebook entries per RVQ level. With `rvq_depth=2`, total combos = num_codes^2.
Default: `32` (32x32 = 1024 composite codes).

```bash
python train_vqvae.py network_config.num_codes=64
```

### proprio_noise_scale

Gaussian noise std added to proprioceptive input of decoder only (training only). Forces decoder to rely on codebook latents.
Default: `0.2`.

```bash
python train_vqvae.py network_config.proprio_noise_scale=0.5
```

---

## Copy-Paste Combos

```bash
python train_vqvae.py network_config.num_codes=128 network_config.stickiness_bias=[2.0,0.0] network_config.proprio_noise_scale=0.3
```

---

## Other Useful Overrides

```bash
# Change run name (shows up in WandB + checkpoint dir)
train_setup.run_name=my_experiment

# Change learning rate
train_setup.train_config.learning_rate=3e-4

# Change number of parallel envs
train_setup.train_config.num_envs=4096

# Change RVQ depth (1 = vanilla VQ, no residual)
network_config.rvq_depth=1

# Change latent dim
network_config.latent_dim=64

# Change commitment cost (encoder -> codebook loss weight)
network_config.commitment_cost=0.25

# Codebook entropy regularization weight (encourages uniform usage)
network_config.codebook_entropy_weight=0.2

# Disable dead code reinitialization
network_config.dead_code_reinit=false

# Resume from checkpoint
train_setup.checkpoint_to_restore=/path/to/checkpoint

# Change random seed
train_setup.train_config.seed=123
```

---

## Network Config Defaults

| Parameter | Default | Notes |
|---|---|---|
| `num_codes` | 32 | Per RVQ level |
| `rvq_depth` | 2 | 1 = vanilla VQ |
| `latent_dim` | 32 | Codebook embedding dim |
| `stickiness_bias` | [1.0, 0.0] | Per-depth temporal bias |
| `proprio_noise_scale` | 0.2 | Decoder-only, training-only |
| `commitment_cost` | 0.1 | Encoder commitment loss weight |
| `codebook_loss_weight` | 1.0 | Codebook learning loss weight |
| `codebook_entropy_weight` | 0.1 | Uniform usage regularization |
| `dead_code_reinit` | true | Reinit unused codes from z_e |
| `dead_code_threshold` | 0.01 | Usage fraction to consider dead |
| `use_rotation` | true | Householder rotation STE (STAR) |
| `encoder_layer_sizes` | [512, 256, 256] | |
| `decoder_layer_sizes` | [512, 512, 256, 256] | |
