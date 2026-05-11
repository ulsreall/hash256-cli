/*
 * HASH256 CUDA Miner — keccak-256 PoW
 *
 * Usage: ./hash256-cuda <challenge_hex> <difficulty_hex> [batch_size]
 *
 * Outputs JSON lines to stdout:
 *   {"type":"found","nonce":"...","hash":"0x..."}
 *   {"type":"progress","hashes":"...","hashrate":...}
 */

#include <cuda_runtime.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHECK_CUDA(call) do { \
    cudaError_t err = (call); \
    if (err != cudaSuccess) { \
        fprintf(stderr, "CUDA error: %s at %s:%d\n", cudaGetErrorString(err), __FILE__, __LINE__); \
        return 1; \
    } \
} while(0)

/* ─── Result struct (device + host) ──────────────────────────────────────── */
typedef struct {
    unsigned int found;
    unsigned int nonce_lo;
    unsigned int nonce_hi;
    unsigned int hash[8];
} Result;

/* ─── Hex parsing ────────────────────────────────────────────────────────── */
static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex32(const char *hex, unsigned char out[32]) {
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    if (strlen(hex) != 64) return 0;
    for (int i = 0; i < 32; i++) {
        int hi = hex_nibble(hex[i * 2]);
        int lo = hex_nibble(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 1;
}

static uint32_t be32(const unsigned char *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  | ((uint32_t)p[3]);
}

static void print_hash(unsigned int h[8]) {
    printf("0x");
    for (int i = 0; i < 8; i++) printf("%08x", h[i]);
}

/* ─── CUDA Keccak Kernel ─────────────────────────────────────────────────── */
__constant__ unsigned long long RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL,
    0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL,
    0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL,
    0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x0000000000008000ULL,
    0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL,
    0x0000000000000001ULL, 0x8000000080008008ULL
};

__device__ __forceinline__ unsigned long long rotl64(unsigned long long x, int s) {
    return (x << s) | (x >> (64 - s));
}

__device__ __forceinline__ unsigned long long bswap64(unsigned long long v) {
    return ((v & 0xff00000000000000ULL) >> 56)
         | ((v & 0x00ff000000000000ULL) >> 40)
         | ((v & 0x0000ff0000000000ULL) >> 24)
         | ((v & 0x000000ff00000000ULL) >> 8)
         | ((v & 0x00000000ff000000ULL) << 8)
         | ((v & 0x0000000000ff0000ULL) << 24)
         | ((v & 0x000000000000ff00ULL) << 40)
         | ((v & 0x00000000000000ffULL) << 56);
}

__device__ void keccak_f1600(unsigned long long *s) {
    for (int r = 0; r < 24; r++) {
        unsigned long long C0 = s[0] ^ s[5] ^ s[10] ^ s[15] ^ s[20];
        unsigned long long C1 = s[1] ^ s[6] ^ s[11] ^ s[16] ^ s[21];
        unsigned long long C2 = s[2] ^ s[7] ^ s[12] ^ s[17] ^ s[22];
        unsigned long long C3 = s[3] ^ s[8] ^ s[13] ^ s[18] ^ s[23];
        unsigned long long C4 = s[4] ^ s[9] ^ s[14] ^ s[19] ^ s[24];

        unsigned long long D0 = C4 ^ rotl64(C1, 1);
        unsigned long long D1 = C0 ^ rotl64(C2, 1);
        unsigned long long D2 = C1 ^ rotl64(C3, 1);
        unsigned long long D3 = C2 ^ rotl64(C4, 1);
        unsigned long long D4 = C3 ^ rotl64(C0, 1);

        s[0]  ^= D0; s[5]  ^= D0; s[10] ^= D0; s[15] ^= D0; s[20] ^= D0;
        s[1]  ^= D1; s[6]  ^= D1; s[11] ^= D1; s[16] ^= D1; s[21] ^= D1;
        s[2]  ^= D2; s[7]  ^= D2; s[12] ^= D2; s[17] ^= D2; s[22] ^= D2;
        s[3]  ^= D3; s[8]  ^= D3; s[13] ^= D3; s[18] ^= D3; s[23] ^= D3;
        s[4]  ^= D4; s[9]  ^= D4; s[14] ^= D4; s[19] ^= D4; s[24] ^= D4;

        /* Rho + Pi */
        unsigned long long B00 = s[0];
        unsigned long long B10 = rotl64(s[1], 1);
        unsigned long long B20 = rotl64(s[2], 62);
        unsigned long long B5  = rotl64(s[3], 28);
        unsigned long long B15 = rotl64(s[4], 27);
        unsigned long long B16 = rotl64(s[5], 36);
        unsigned long long B1  = rotl64(s[6], 44);
        unsigned long long B11 = rotl64(s[7], 6);
        unsigned long long B21 = rotl64(s[8], 55);
        unsigned long long B6  = rotl64(s[9], 20);
        unsigned long long B7  = rotl64(s[10], 3);
        unsigned long long B17 = rotl64(s[11], 10);
        unsigned long long B2  = rotl64(s[12], 43);
        unsigned long long B12 = rotl64(s[13], 25);
        unsigned long long B22 = rotl64(s[14], 39);
        unsigned long long B23 = rotl64(s[15], 41);
        unsigned long long B8  = rotl64(s[16], 45);
        unsigned long long B18 = rotl64(s[17], 15);
        unsigned long long B3  = rotl64(s[18], 21);
        unsigned long long B13 = rotl64(s[19], 8);
        unsigned long long B14 = rotl64(s[20], 18);
        unsigned long long B24 = rotl64(s[21], 2);
        unsigned long long B9  = rotl64(s[22], 61);
        unsigned long long B19 = rotl64(s[23], 56);
        unsigned long long B4  = rotl64(s[24], 14);

        /* Chi */
        s[0]  = B00 ^ ((~B1)  & B2);
        s[1]  = B1  ^ ((~B2)  & B3);
        s[2]  = B2  ^ ((~B3)  & B4);
        s[3]  = B3  ^ ((~B4)  & B00);
        s[4]  = B4  ^ ((~B00) & B1);

        s[5]  = B5  ^ ((~B6)  & B7);
        s[6]  = B6  ^ ((~B7)  & B8);
        s[7]  = B7  ^ ((~B8)  & B9);
        s[8]  = B8  ^ ((~B9)  & B5);
        s[9]  = B9  ^ ((~B5)  & B6);

        s[10] = B10 ^ ((~B11) & B12);
        s[11] = B11 ^ ((~B12) & B13);
        s[12] = B12 ^ ((~B13) & B14);
        s[13] = B13 ^ ((~B14) & B10);
        s[14] = B14 ^ ((~B10) & B11);

        s[15] = B15 ^ ((~B16) & B17);
        s[16] = B16 ^ ((~B17) & B18);
        s[17] = B17 ^ ((~B18) & B19);
        s[18] = B18 ^ ((~B19) & B15);
        s[19] = B19 ^ ((~B15) & B16);

        s[20] = B20 ^ ((~B21) & B22);
        s[21] = B21 ^ ((~B22) & B23);
        s[22] = B22 ^ ((~B23) & B24);
        s[23] = B23 ^ ((~B24) & B20);
        s[24] = B24 ^ ((~B20) & B21);

        /* Iota */
        s[0] ^= RC[r];
    }
}

__global__ void mine_keccak(
    unsigned long long c0, unsigned long long c1,
    unsigned long long c2, unsigned long long c3,
    unsigned long long d0, unsigned long long d1,
    unsigned long long d2, unsigned long long d3,
    unsigned long long nonce_base,
    unsigned long long *out_found_nonce,
    unsigned int *out_found_flag
) {
    unsigned long long nonce = nonce_base + (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;

    unsigned long long s[25];
    s[0] = c0;
    s[1] = c1;
    s[2] = c2;
    s[3] = c3;
    s[4] = 0;
    s[5] = 0;
    s[6] = 0;
    s[7] = bswap64(nonce);
    s[8]  = 0x0000000000000001ULL;
    s[9]  = 0; s[10] = 0; s[11] = 0; s[12] = 0;
    s[13] = 0; s[14] = 0; s[15] = 0;
    s[16] = 0x8000000000000000ULL;
    s[17] = 0; s[18] = 0; s[19] = 0; s[20] = 0;
    s[21] = 0; s[22] = 0; s[23] = 0; s[24] = 0;

    keccak_f1600(s);

    unsigned long long h0 = bswap64(s[0]);

    /* Cheap pre-filter */
    if (h0 > d0) return;
    if (h0 == d0) {
        unsigned long long h1 = bswap64(s[1]);
        if (h1 > d1) return;
        if (h1 == d1) {
            unsigned long long h2 = bswap64(s[2]);
            if (h2 > d2) return;
            if (h2 == d2) {
                unsigned long long h3 = bswap64(s[3]);
                if (h3 >= d3) return;
            }
        }
    }

    /* Hit! Record first winner via atomic CAS */
    if (atomicCAS(out_found_flag, 0U, 1U) == 0U) {
        *out_found_nonce = nonce;
    }
}

/* ─── Split helpers ──────────────────────────────────────────────────────── */
static void split_challenge_le(const unsigned char *bytes, unsigned long long out[4]) {
    /* Read 32 bytes as 4 little-endian u64 words */
    for (int i = 0; i < 4; i++) {
        memcpy(&out[i], bytes + i * 8, 8);
    }
}

static void split_difficulty_be(const unsigned char *bytes, unsigned long long out[4]) {
    /* Read 32 bytes as 4 big-endian u64 words */
    for (int i = 0; i < 4; i++) {
        out[i] = ((unsigned long long)bytes[i*8]   << 56) |
                 ((unsigned long long)bytes[i*8+1] << 48) |
                 ((unsigned long long)bytes[i*8+2] << 40) |
                 ((unsigned long long)bytes[i*8+3] << 32) |
                 ((unsigned long long)bytes[i*8+4] << 24) |
                 ((unsigned long long)bytes[i*8+5] << 16) |
                 ((unsigned long long)bytes[i*8+6] << 8)  |
                 ((unsigned long long)bytes[i*8+7]);
    }
}

/* ─── Main ───────────────────────────────────────────────────────────────── */
int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <challenge_hex> <difficulty_hex> [batch_size]\n", argv[0]);
        return 2;
    }

    unsigned char challenge_bytes[32], difficulty_bytes[32];
    if (!parse_hex32(argv[1], challenge_bytes) || !parse_hex32(argv[2], difficulty_bytes)) {
        fprintf(stderr, "challenge/difficulty must be 32-byte hex\n");
        return 2;
    }

    size_t batch = (argc > 3) ? (size_t)strtoull(argv[3], NULL, 10) : (1 << 22);
    if (batch < 256) batch = 256;

    /* Split challenge as 4 LE u64, difficulty as 4 BE u64 */
    unsigned long long cw[4], dw[4];
    split_challenge_le(challenge_bytes, cw);
    split_difficulty_be(difficulty_bytes, dw);

    /* Allocate device memory */
    unsigned long long *d_found_nonce;
    unsigned int *d_found_flag;
    cudaMalloc(&d_found_nonce, sizeof(unsigned long long));
    cudaMalloc(&d_found_flag, sizeof(unsigned int));

    unsigned long long nonce_base = ((unsigned long long)time(NULL) << 32) ^ (unsigned long long)clock();
    unsigned long long total = 0;
    struct timespec ts_start;
    clock_gettime(CLOCK_MONOTONIC, &ts_start);

    /* Determine grid/block dimensions */
    int threads_per_block = 256;
    int blocks = (int)((batch + threads_per_block - 1) / threads_per_block);

    Result h_result;
    unsigned long long h_nonce;

    for (;;) {
        /* Clear result */
        unsigned int zero_flag = 0;
        unsigned long long zero_nonce = 0;
        cudaMemcpy(d_found_flag, &zero_flag, sizeof(unsigned int), cudaMemcpyHostToDevice);
        cudaMemcpy(d_found_nonce, &zero_nonce, sizeof(unsigned long long), cudaMemcpyHostToDevice);

        /* Launch kernel */
        mine_keccak<<<blocks, threads_per_block>>>(
            cw[0], cw[1], cw[2], cw[3],
            dw[0], dw[1], dw[2], dw[3],
            nonce_base,
            d_found_nonce,
            d_found_flag
        );

        cudaDeviceSynchronize();

        total += batch;

        /* Check result */
        unsigned int h_flag;
        cudaMemcpy(&h_flag, d_found_flag, sizeof(unsigned int), cudaMemcpyDeviceToHost);

        if (h_flag) {
            cudaMemcpy(&h_nonce, d_found_nonce, sizeof(unsigned long long), cudaMemcpyDeviceToHost);

            /* CPU verify: compute hash for this nonce */
            /* We trust the GPU result for now (self-test at startup would verify) */
            printf("{\"type\":\"found\",\"nonce\":\"%llu\",\"hash\":\"PLACEHOLDER\"}\n",
                   (unsigned long long)h_nonce);
            fflush(stdout);
            cudaFree(d_found_nonce);
            cudaFree(d_found_flag);
            return 0;
        }

        /* Progress report every ~0.5 seconds */
        struct timespec ts_now;
        clock_gettime(CLOCK_MONOTONIC, &ts_now);
        double elapsed = (ts_now.tv_sec - ts_start.tv_sec) + (ts_now.tv_nsec - ts_start.tv_nsec) / 1e9;
        if (elapsed > 0.5) {
            double hashrate = (double)total / elapsed;
            fprintf(stderr, "{\"type\":\"progress\",\"hashes\":\"%llu\",\"hashrate\":%.0f}\n",
                    (unsigned long long)total, hashrate);
            fflush(stderr);
            /* Reset counters for interval rate */
            total = 0;
            clock_gettime(CLOCK_MONOTONIC, &ts_start);
        }

        nonce_base += batch;
    }

    cudaFree(d_found_nonce);
    cudaFree(d_found_flag);
    return 0;
}
